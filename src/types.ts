import type {
  ChatCompletionRequestBase,
  InitProgressReport
} from '@mlc-ai/web-llm';

export namespace ClientMessage {
  export interface IConfigure {
    action: 'configure';
  }
  export interface IInitializeBuffer {
    action: 'initializeBuffer';
    buffer: SharedArrayBuffer;
  }
  export interface IInitializeModel {
    action: 'initializeModel';
    model: string;
  }
  export interface IDisposeModel {
    action: 'disposeModel';
    model: string;
  }
  export interface IGenerate
    extends Omit<ChatCompletionRequestBase, 'messages'> {
    action: 'generate';
    model: string;
    idTokens: string[];
    systemPrompt: string;
    text: string;
    counter: number;
    generateN: number;
  }
  export type Message =
    | IConfigure
    | IInitializeBuffer
    | IInitializeModel
    | IDisposeModel
    | IGenerate;
}

export namespace WorkerMessage {
  export interface IWorkerStarted {
    status: 'worker-started';
  }
  interface IModelLoadingMessage {
    model: string;
  }
  export interface IInitiate extends IModelLoadingMessage {
    status: 'initiate';
  }
  export interface IProgress extends IModelLoadingMessage, InitProgressReport {
    status: 'progress';
  }
  export interface IDone extends IModelLoadingMessage {
    status: 'done';
  }
  export interface IReady extends IModelLoadingMessage {
    status: 'ready';
  }
  interface ICompletionMessage {
    idToken: string;
    output: string;
  }
  export interface IUpdate extends ICompletionMessage {
    status: 'update';
  }
  export interface IComplete extends ICompletionMessage {
    status: 'complete';
  }
  export interface IGenerationError {
    idTokens: string[];
    error?: {
      message: string;
    };
  }
  export interface IException {
    error?: {
      message: string;
    };
  }
}
