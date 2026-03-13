// ---------------------------------------------------------------------------
// A2A Protocol v1.0.0 TypeScript Types
// ---------------------------------------------------------------------------

// --- Parts ---

export interface TextPart {
  type: 'text';
  text: string;
}

export interface DataPart {
  type: 'data';
  data: Record<string, unknown>;
  mimeType?: string;
}

export interface FilePart {
  type: 'file';
  file: {
    name: string;
    mimeType: string;
    bytes?: string; // base64
    uri?: string;
  };
}

export type A2APart = TextPart | DataPart | FilePart;

// --- Message ---

export interface A2AMessage {
  role: 'user' | 'agent';
  parts: A2APart[];
  messageId?: string;
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

// --- Artifact ---

export interface A2AArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2APart[];
  index?: number;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

// --- Task State ---

export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'
  | 'auth-required'
  | 'unknown';

// --- Task Status ---

export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: A2AMessage;
  timestamp?: string;
}

// --- Task ---

export interface A2ATask {
  kind: 'task';
  id: string;
  contextId?: string;
  status: A2ATaskStatus;
  history?: A2AMessage[];
  artifacts?: A2AArtifact[];
  metadata?: Record<string, unknown>;
}

// --- Push Notification Config ---

export interface PushNotificationConfig {
  url: string;
  token?: string;
  authentication?: {
    schemes?: string[];
    credentials?: string;
  };
}

// --- JSON-RPC Base ---

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// --- Method Params ---

export interface MessageSendParams {
  message: A2AMessage;
  configuration?: {
    acceptedOutputModes?: string[];
    pushNotificationConfig?: PushNotificationConfig;
    historyLength?: number;
    blocking?: boolean;
  };
  metadata?: Record<string, unknown>;
}

export interface GetTaskParams {
  id: string;
  historyLength?: number;
  metadata?: Record<string, unknown>;
}

export interface ListTasksParams {
  pageSize?: number;
  pageToken?: string;
  metadata?: Record<string, unknown>;
}

export interface ListTasksResult {
  tasks: A2ATask[];
  nextPageToken?: string;
}

export interface CancelTaskParams {
  id: string;
  metadata?: Record<string, unknown>;
}

export interface SetPushNotificationParams {
  id: string;
  pushNotificationConfig: PushNotificationConfig;
}

// --- Events (SSE) ---

export interface TaskStatusUpdateEvent {
  id: string;
  status: A2ATaskStatus;
  final: boolean;
  metadata?: Record<string, unknown>;
}

export interface TaskArtifactUpdateEvent {
  id: string;
  artifact: A2AArtifact;
  metadata?: Record<string, unknown>;
}

// --- A2A Error Codes ---

export const A2AErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // A2A-specific
  TaskNotFound: -32001,
  TaskNotCancelable: -32002,
  PushNotificationNotSupported: -32003,
  UnsupportedOperation: -32004,
  ContentTypeNotSupported: -32005,
  InvalidAgentResponse: -32006,
} as const;

export type A2AErrorCode = (typeof A2AErrorCode)[keyof typeof A2AErrorCode];

// --- Named method strings ---
export const A2AMethods = {
  MessageSend: 'message/send',
  MessageStream: 'message/stream',
  TasksGet: 'tasks/get',
  TasksList: 'tasks/list',
  TasksCancel: 'tasks/cancel',
  TasksPushNotificationSet: 'tasks/pushNotification/set',
  TasksPushNotificationGet: 'tasks/pushNotification/get',
  TasksSubscribe: 'tasks/subscribe',
} as const;
