import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  ICompletionProviderManager,
  IInlineCompletionProvider,
  IInlineCompletionContext,
  CompletionHandler,
  IInlineCompletionList,
  IInlineCompletionItem
} from '@jupyterlab/completer';
import type { ISettingRegistry } from '@jupyterlab/settingregistry';
import { Notification, showErrorMessage } from '@jupyterlab/apputils';
import { JSONValue, PromiseDelegate } from '@lumino/coreutils';
import type { ClientMessage, WorkerMessage } from './types';
import { Descriptions } from './descriptions';
import {
  prebuiltAppConfig,
  ModelRecord,
  GenerationConfig
} from '@mlc-ai/web-llm';

const codeModels = [...prebuiltAppConfig.model_list];
codeModels.length = 0; // TODO
const textModels = prebuiltAppConfig.model_list;

interface ISettings extends GenerationConfig {
  codeModel: string;
  textModel: string;
  maxContextWindow: number;
  generateN: number;
}

const DEFAULT_SETTINGS: ISettings = {
  codeModel: 'none',
  textModel: 'Llama-3-8B-Instruct-q4f32_1-1k',
  temperature: 0.5,
  top_p: null,
  generateN: 2,
  max_gen_len: 512,
  frequency_penalty: 0,
  presence_penalty: 0,
  repetition_penalty: 0,
  maxContextWindow: 525
};

class WebLLMInlineProvider implements IInlineCompletionProvider {
  readonly identifier = '@jupyterlab/web-llm-completer';
  readonly name = 'Web-llm powered completions';

  constructor(protected options: WebLLMInlineProvider.IOptions) {
    try {
      SharedArrayBuffer;
    } catch (e) {
      showErrorMessage(
        'SharedArrayBuffer not available',
        'Server extension enabling `same-origin` and `require-corp` headers is required for jupyterlab-web-llm-completer to access `SharedArrayBuffer` which is used to synchronously communicate with the language model WebWorker.'
      );
    }
    const buffer = new SharedArrayBuffer(1024);
    this._sharedArray = new Int32Array(buffer);
    options.worker.addEventListener(
      'message',
      this._onMessageReceived.bind(this)
    );
    this._workerStarted.promise.then(() => {
      this._postMessage({
        action: 'initializeBuffer',
        buffer: buffer
      });
    });
  }

  get schema(): ISettingRegistry.IProperty {
    return {
      properties: {
        codeModel: {
          title: 'Code model',
          description: 'Model used in code cells and code files.',
          oneOf: [
            { const: 'none', title: 'No model' },
            ...codeModels.map(this._formatModelOptions)
          ],
          type: 'string'
        },
        textModel: {
          title: 'Text model',
          description:
            'Model used in Markdown (cells and files) and plain text files.',
          oneOf: [
            { const: 'none', title: 'No model' },
            ...textModels.map(this._formatModelOptions)
          ],
          type: 'string'
        },
        // TODO temperature and friends should be per-model
        temperature: {
          minimum: 0,
          type: 'number',
          title: 'Temperature',
          description: Descriptions['temperature']
        },
        top_p: {
          minimum: 0,
          maximum: 1,
          type: ['number', 'null'],
          title: 'Top P',
          default: null,
          description: Descriptions['top_p']
        },
        max_gen_len: {
          minimum: 1,
          maximum: 512,
          type: 'number',
          title: 'Tokens limit',
          description: 'Maximum number of new tokens.'
        },
        generateN: {
          minimum: 1,
          type: 'number',
          title: 'Candidates',
          description: 'How many completion candidates should be generated.'
        },
        frequency_penalty: {
          minimum: -2,
          maximum: 2,
          type: 'number',
          title: Descriptions['frequency_penalty']
        },
        presence_penalty: {
          minimum: -2,
          maximum: 2,
          type: 'number',
          title: Descriptions['presence_penalty']
        },
        // TODO: characters are a poor proxy for number of tokens when whitespace are many (though a strictly conservative one).
        // Words could be better but can be over-optimistic - one word can be several tokens).
        maxContextWindow: {
          title: 'Context window',
          minimum: 1,
          type: 'number',
          description:
            'At most how many characters should be provided to the model. Smaller context results in faster generation at a cost of less accurate suggestions.'
        }
      },
      default: DEFAULT_SETTINGS as any
    };
  }

  async configure(settings: { [property: string]: JSONValue }): Promise<void> {
    this._settings = settings as any as ISettings;
    await this._workerStarted.promise;
    this._switchModel(this._settings.codeModel, 'code');
    this._switchModel(this._settings.textModel, 'text');
  }

  async fetch(
    request: CompletionHandler.IRequest,
    context: IInlineCompletionContext
  ): Promise<IInlineCompletionList<IInlineCompletionItem>> {
    const textMimeTypes = [
      'text/x-ipythongfm',
      'text/x-markdown',
      'text/plain',
      'text/x-rst',
      'text/x-latex',
      'text/x-rsrc'
    ];
    const isText = textMimeTypes.includes(request.mimeType!);
    // TODO add a setting to only invoke on text if explicitly asked (triggerKind = invoke)
    const model = isText ? this._settings.textModel : this._settings.codeModel;

    await this._ready[model].promise;
    this._abortPrevious();
    this._streamPromises = new Map();

    const prefix = this._prefixFromRequest(request);
    const items: IInlineCompletionItem[] = [];
    const idTokens = [];
    for (let i = 0; i < this._settings.generateN; i++) {
      const token = 'T' + ++this._tokenCounter;
      idTokens.push(token);
      items.push({
        insertText: '',
        isIncomplete: true,
        token: token
      });
    }
    this._postMessage({
      model,
      text: prefix,
      systemPrompt:
        'You are a completion model generating ' +
        (isText ? 'Markdown' : 'code') +
        ' suggestions',
      temperature: this._settings.temperature,
      top_p: this._settings.top_p,
      generateN: this._settings.generateN,
      frequency_penalty: this._settings.frequency_penalty,
      presence_penalty: this._settings.presence_penalty,
      idTokens,
      action: 'generate',
      counter: this._currentGeneration
    });
    return { items };
  }

  /**
   * Stream a reply for completion identified by given `token`.
   */
  async *stream(token: string) {
    let done = false;
    while (!done) {
      const delegate = new PromiseDelegate<IStream>();
      this._streamPromises.set(token, delegate);
      const promise = delegate.promise;
      yield promise;
      done = (await promise).done;
    }
  }

  /**
   * Handle message from the web worker.
   */
  private _onMessageReceived(event: MessageEvent) {
    const data = event.data;
    switch (data.status) {
      case 'worker-started':
        this._msgWorkerStarted(data as WorkerMessage.IWorkerStarted);
        break;
      case 'initiate':
        this._msgInitiate(data as WorkerMessage.IInitiate);
        break;
      case 'progress':
        this._msgProgress(data as WorkerMessage.IProgress);
        break;
      case 'done':
        this._msgDone(data as WorkerMessage.IDone);
        break;
      case 'ready':
        this._msgReady(data as WorkerMessage.IReady);
        break;
      case 'update':
        this._msgUpdate(data as WorkerMessage.IUpdate);
        break;
      case 'complete':
        this._msgComplete(data as WorkerMessage.IComplete);
        break;
      case 'interrupted':
        this._msgInterrupted(data as WorkerMessage.IGenerationError);
        break;
      case 'exception':
        this._msgException(data as WorkerMessage.IGenerationError);
        break;
      default:
        console.warn('Unhandled message from worker:', data);
        break;
    }
  }

  private _msgWorkerStarted(_data: WorkerMessage.IWorkerStarted) {
    this._workerStarted.resolve(undefined);
  }

  private _msgInitiate(data: WorkerMessage.IInitiate) {
    this._ready[data.model] = new PromiseDelegate();
    const message = `Loading ${data.model}`;
    if (this._loadingNotifications[data.model]) {
      Notification.update({
        id: this._loadingNotifications[data.model],
        message,
        autoClose: false
      });
    } else {
      this._loadingNotifications[data.model] = Notification.emit(
        message,
        'in-progress',
        { autoClose: false }
      );
    }
  }

  private _msgProgress(data: WorkerMessage.IProgress) {
    Notification.update({
      id: this._loadingNotifications[data.model],
      message: `Loading ${data.model}: ${data.text} ${Math.round(
        data.progress * 100
      )}% (${data.timeElapsed})`,
      type: 'in-progress',
      autoClose: false,
      progress: data.progress
    });
  }

  private _msgDone(data: WorkerMessage.IDone) {
    Notification.update({
      id: this._loadingNotifications[data.model],
      message: `Loaded ${data.model}, compiling...`,
      type: 'success',
      autoClose: false
    });
  }

  private _msgReady(data: WorkerMessage.IReady) {
    Notification.dismiss(this._loadingNotifications[data.model]);
    this._ready[data.model].resolve(void 0);
  }

  private _msgUpdate(data: WorkerMessage.IUpdate) {
    this._tickWorker();
    const token = data.idToken;
    const delegate = this._streamPromises.get(token);
    if (!delegate) {
      console.warn('Completion updated but stream absent');
    } else {
      delegate.resolve({
        done: false,
        response: {
          insertText: data.output
        }
      });
    }
  }

  private _msgComplete(data: WorkerMessage.IComplete) {
    const token = data.idToken;
    const delegate = this._streamPromises.get(token);
    if (!delegate) {
      console.warn('Completion done but stream absent');
    } else {
      delegate.resolve({
        done: true,
        response: {
          insertText: data.output
        }
      });
    }
    this._streamPromises.delete(token);
  }

  private _msgInterrupted(data: WorkerMessage.IGenerationError) {
    // handle interruption
    for (const token of data.idTokens) {
      const delegate = this._streamPromises.get(token);
      if (delegate) {
        delegate.reject(null);
      }
      this._streamPromises.delete(token);
    }
  }

  private _msgException(data: WorkerMessage.IException) {
    Notification.error(`Worker error: ${data.error?.message}`);
    console.error(data);
  }

  /**
   * Summarise model for display in user settings.
   */
  private _formatModelOptions(model: ModelRecord) {
    const requirements: string[] = [];
    if (model.required_features && model.required_features.length > 0) {
      requirements.push(...model.required_features);
    }
    if (model.vram_required_MB) {
      requirements.push(model.vram_required_MB + ' MB VRAM');
    }
    const modelName =
      model.model_id +
      (requirements ? ' (' + requirements.join(', ') + ' required)' : '');
    return {
      const: model.model_id,
      title: `${modelName}`
    };
  }

  /**
   * Send a tick to the worker with number of current generation counter.
   */
  private _tickWorker() {
    Atomics.store(this._sharedArray, 0, this._currentGeneration);
    Atomics.notify(this._sharedArray, 0, 1);
  }

  /**
   * Communicate to the worker that previous suggestion no longer needs to be generated.
   */
  private _abortPrevious() {
    this._currentGeneration++;
    this._tickWorker();
  }

  /**
   * Extract prefix from request, accounting for context window limit.
   */
  private _prefixFromRequest(request: CompletionHandler.IRequest): string {
    const textBefore = request.text.slice(0, request.offset);
    const prefix = textBefore.slice(
      -Math.min(this._settings.maxContextWindow, textBefore.length)
    );
    return prefix;
  }

  /**
   * A type-guarded shorthand to post message to the worker.
   */
  private _postMessage(message: ClientMessage.Message) {
    this.options.worker.postMessage(message);
  }

  /**
   * Switch generative model for given `type` of content.
   */
  private _switchModel(newModel: string, type: 'code' | 'text') {
    const oldModel = this._currentModels[type];
    if (oldModel === newModel) {
      return;
    }
    if (oldModel) {
      this._postMessage({
        action: 'disposeModel',
        model: oldModel
      });
    }
    if (newModel !== 'none') {
      this._postMessage({
        action: 'initializeModel',
        model: newModel
      });
    }
    this._currentModels[type] = newModel;
  }

  private _currentGeneration = 0;
  private _currentModels: {
    code?: string;
    text?: string;
  } = {};
  private _loadingNotifications: Record<string, string> = {};
  private _ready: Record<string, PromiseDelegate<void>> = {};
  private _settings: ISettings = DEFAULT_SETTINGS;
  private _sharedArray: Int32Array;
  private _streamPromises: Map<string, PromiseDelegate<IStream>> = new Map();
  private _tokenCounter = 0;
  private _workerStarted = new PromiseDelegate();
}

namespace WebLLMInlineProvider {
  export interface IOptions {
    worker: Worker;
  }
}

interface IStream {
  done: boolean;
  response: IInlineCompletionItem;
}

/**
 * Initialization data for the @jupyterlab/web-llm-completer extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyterlab/web-llm-completer:plugin',
  description: 'An in-browser AI completion provider for JupyterLab.',
  requires: [ICompletionProviderManager],
  autoStart: true,
  activate: (
    app: JupyterFrontEnd,
    providerManager: ICompletionProviderManager
  ) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url));
    const provider = new WebLLMInlineProvider({ worker });
    providerManager.registerInlineProvider(provider);
  }
};

export default plugin;
