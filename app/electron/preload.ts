import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";
import type {
  InvokeChannel,
  InvokeRequest,
  InvokeResponse,
  EventChannel,
  EventPayload,
  PromptyBridge,
} from "../src/shared/ipc";

const bridge: PromptyBridge = {
  invoke<C extends InvokeChannel>(
    channel: C,
    payload: InvokeRequest<C>,
  ): Promise<InvokeResponse<C>> {
    return ipcRenderer.invoke(channel, payload) as Promise<InvokeResponse<C>>;
  },
  on<C extends EventChannel>(
    channel: C,
    handler: (payload: EventPayload<C>) => void,
  ): () => void {
    const listener = (_event: IpcRendererEvent, payload: EventPayload<C>) => {
      handler(payload);
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
};

contextBridge.exposeInMainWorld("prompty", bridge);
