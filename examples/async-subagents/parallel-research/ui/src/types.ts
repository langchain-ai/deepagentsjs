export interface AsyncTask {
  taskId: string;
  agentName: string;
  threadId: string;
  runId: string;
  status: string;
  description?: string;
}
