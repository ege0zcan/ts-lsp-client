import { JSONRPCClient, JSONRPCRequest, JSONRPCResponse } from 'json-rpc-2.0';
import {EventEmitter, Readable, TransformOptions, Writable} from 'stream';
import { JSONRPCTransform } from './jsonRpcTransform';
import { Logger, LoggerLevel } from './logger';
import {JSONRPCParams} from "json-rpc-2.0/dist/models";

export class JSONRPCEndpoint extends EventEmitter {

    private writable: Writable;
    private readable: Readable;
    private readableByline: JSONRPCTransform;
    private client: JSONRPCClient;
    private nextId: number;

    public constructor(writable: Writable, readable: Readable, options?: ConstructorParameters<typeof EventEmitter>[0] & TransformOptions) {
        super(options);
        this.nextId = 0;
        const createId = () => this.nextId++;
        this.writable = writable;
        this.readable = readable;
        this.readableByline = JSONRPCTransform.createStream(this.readable, options);

        this.client = new JSONRPCClient(async (jsonRPCRequest) => {
            const jsonRPCRequestStr = JSON.stringify(jsonRPCRequest);
            Logger.log(`sending: ${jsonRPCRequestStr}`, LoggerLevel.DEBUG);
            const contentLength = Buffer.from(jsonRPCRequestStr, 'utf-8').byteLength;
            this.writable.write(`Content-Length: ${contentLength}\r\n\r\n${jsonRPCRequestStr}`);
        }, createId);

        this.readableByline.on('data', (jsonRPCResponseOrRequest: string) => {
            const jsonrpc = JSON.parse(jsonRPCResponseOrRequest);
            Logger.log(`[transform] ${jsonRPCResponseOrRequest}`, LoggerLevel.DEBUG);

            // Check if it's a response (has id and result/error properties)
            if (Object.prototype.hasOwnProperty.call(jsonrpc, 'id') && 
                (Object.prototype.hasOwnProperty.call(jsonrpc, 'result') || Object.prototype.hasOwnProperty.call(jsonrpc, 'error'))) {
                
                const jsonRPCResponse: JSONRPCResponse = jsonrpc as JSONRPCResponse;
                if (jsonRPCResponse.id === (this.nextId - 1)) {
                    this.client.receive(jsonRPCResponse);
                } else {
                    Logger.log(`[transform] ${jsonRPCResponseOrRequest}`, LoggerLevel.ERROR);
                    this.emit('error', `[transform] Received id mismatch! Got ${jsonRPCResponse.id}, expected ${this.nextId - 1}`);
                }
            } 
            // It's a request or notification (has method property)
            else if (Object.prototype.hasOwnProperty.call(jsonrpc, 'method')) {
                const jsonRPCRequest: JSONRPCRequest = jsonrpc as JSONRPCRequest;
                // Pass the request ID if it exists (for server requests)
                if (Object.prototype.hasOwnProperty.call(jsonrpc, 'id')) {
                    this.emit(jsonRPCRequest.method, jsonRPCRequest.params, jsonRPCRequest.id);
                } else {
                    this.emit(jsonRPCRequest.method, jsonRPCRequest.params);
                }
            }
            else {
                Logger.log(`[transform] Received invalid JSON-RPC message: ${jsonRPCResponseOrRequest}`, LoggerLevel.ERROR);
                this.emit('error', `[transform] Received invalid JSON-RPC message: ${jsonRPCResponseOrRequest}`);
            }
        });
    }

    public send(method: string, message?: JSONRPCParams): ReturnType<JSONRPCClient["request"]> {
        return this.client.request(method, message);
    }

    public notify(method: string, message?: JSONRPCParams): void {
        this.client.notify(method, message);
    }

    /**
     * Respond to a server request with the given ID
     * @param id The ID of the server request to respond to
     * @param result The result to send back to the server
     */
    public respondToRequest(id: number, result: any): void {
        const response = {
            jsonrpc: "2.0",
            id: id,
            result: result
        };
        const responseStr = JSON.stringify(response);
        Logger.log(`responding to request ${id}: ${responseStr}`, LoggerLevel.DEBUG);
        const contentLength = Buffer.from(responseStr, 'utf-8').byteLength;
        this.writable.write(`Content-Length: ${contentLength}\r\n\r\n${responseStr}`);
    }
}
