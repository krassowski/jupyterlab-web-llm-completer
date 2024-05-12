import type { ClientMessage as Message, WorkerMessage } from './types';

import type {
  ChatCompletionRequest,
  EngineInterface,
  InitProgressReport
} from '@mlc-ai/web-llm';
//import * as webllm from "@mlc-ai/web-llm";
const webllm = await require('@mlc-ai/web-llm/lib');
//const transformers = await require('@xenova/transformers/dist/transformers');

class Worker {
  async handleMessage(event: MessageEvent) {
    const data = event.data;
    switch (data.action) {
      case 'generate':
        return this._generate(data as Message.IGenerate);
      case 'configure':
        return this._configure(data as Message.IConfigure);
      case 'initializeBuffer':
        return this._initializeBuffer(data as Message.IInitializeBuffer);
      case 'initializeModel': {
        const model = this._initializeModel(data as Message.IInitializeModel);
        model.instance.catch(e => {
          self.postMessage({
            status: 'exception',
            error: {
              message: e instanceof Error ? e.message : JSON.stringify(e)
            }
          } as WorkerMessage.IException);
        });
        return;
      }
      case 'disposeModel':
        return this._disposeModel(data as Message.IDisposeModel);
      default:
        console.error('Unhandled message', event);
        break;
    }
  }

  private async _generate(data: Message.IGenerate) {
    const { model: modelName, text, idTokens, counter: startCounter } = data;

    const sharedArray = this._sharedArray;
    if (sharedArray === null) {
      throw Error(
        'Cannot generate before `initializeBuffer` message got processed'
      );
    }
    let engine: EngineInterface;
    try {
      const model = this._initializeModel({ model: modelName });
      engine = await model.instance;
    } catch (e) {
      self.postMessage({
        status: 'exception',
        error: {
          message: e instanceof Error ? e.message : JSON.stringify(e)
        }
      } as WorkerMessage.IException);
      return;
    }

    const generationCounter = sharedArray[0];
    if (generationCounter !== startCounter) {
      console.log('Skipping generation because new request was sent since');
      return;
    }

    const request: ChatCompletionRequest = {
      stream: true,
      messages: [
        {
          role: 'system',
          content:
            'You are a pirate chatbot who always responds in pirate speak!'
        },
        { role: 'user', content: text }
      ],
      n: idTokens.length,
      //logprobs: true,
      //top_logprobs: 2,
      temperature: data.temperature,
      frequency_penalty: data.frequency_penalty,
      presence_penalty: data.presence_penalty,
      max_gen_len: data.max_gen_len,
      top_p: data.top_p
    };
    console.log(request);
    const output = Array(idTokens.length).fill('');
    try {
      const asyncChunkGenerator = await engine.chat.completions.create(request);
      for await (const chunk of asyncChunkGenerator) {
        const generationCounter = sharedArray[0];
        if (generationCounter !== startCounter) {
          // TODO: use `stopping_condition`
          engine.interruptGenerate();
          throw Error('Execution interrupted');
        }
        console.log(chunk);
        for (let i = 0; i < idTokens.length; i++) {
          if (chunk.choices[i].delta.content) {
            // Last chunk has undefined content
            output[i] += chunk.choices[i].delta.content;
          }
          self.postMessage({
            status: 'update',
            output: output[i].substring(text.length),
            idToken: idTokens[i]
          } as WorkerMessage.IUpdate);
        }
      }
    } catch (e: unknown) {
      const errorData = {
        error: {
          message: (e as Error).message
        },
        idTokens
      };
      if ((e as Error).message === 'Execution interrupted') {
        self.postMessage({
          status: 'interrupted',
          ...errorData
        } as WorkerMessage.IGenerationError);
      } else {
        self.postMessage({
          status: 'exception',
          ...errorData
        } as WorkerMessage.IGenerationError);
      }
    }

    for (let i = 0; i < output.length; i++) {
      self.postMessage({
        status: 'complete',
        output: output[i].generated_text.substring(text.length),
        idToken: idTokens[i]
      } as WorkerMessage.IComplete);
    }
  }

  /* Can throw in now WebGPU! */
  private _initializeModel(data: { model: string }): CompletionModel {
    let model = this._completionModels.get(data.model);
    if (model) {
      return model;
    }
    self.postMessage({
      status: 'initiate',
      model: data.model
    } as WorkerMessage.IInitiate);
    model = new CompletionModel({
      model: data.model,
      onLoadingProgress: (progress: InitProgressReport) => {
        console.log(progress);
        self.postMessage({
          ...progress,
          model: data.model,
          status: 'progress'
        } as WorkerMessage.IProgress);
      }
    });
    model.instance.then(() => {
      self.postMessage({
        status: 'done',
        model: data.model
      } as WorkerMessage.IDone);
    });
    this._completionModels.set(data.model, model);
    return model;
  }

  private _configure(_: Message.IConfigure) {
    // no-op
  }

  private _initializeBuffer(data: Message.IInitializeBuffer) {
    this._sharedArray = new Int32Array(data.buffer);
  }

  private _disposeModel(data: Message.IDisposeModel) {
    const model = this._completionModels.get(data.model);
    if (!model) {
      return;
    }
    this._completionModels.delete(data.model);
    return model.dispose();
  }

  private _sharedArray: Int32Array | null = null;
  private _completionModels: Map<string, CompletionModel> = new Map();
}

class CompletionModel {
  constructor(options: CompletionModel.IOptions) {
    this._instance = webllm.CreateEngine(options.model, {
      initProgressCallback: options.onLoadingProgress
    });
  }

  get instance() {
    return this._instance;
  }

  async dispose() {
    const engine = await this._instance;
    engine.resetChat();
    engine.unload();
  }

  private _instance: Promise<EngineInterface>;
}

namespace CompletionModel {
  export interface IOptions {
    model: string;
    onLoadingProgress: (progress: any) => void;
  }
}

export const worker = new Worker();
self.addEventListener('message', worker.handleMessage.bind(worker));
self.postMessage({ status: 'worker-started' } as WorkerMessage.IWorkerStarted);
