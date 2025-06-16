/**
 * Transport Management Module
 * Handles STDIO and SSE transport setup and lifecycle management
 */

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express, { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ConfigManager } from "../config/index.js";
import { Logger } from "../logging/index.js";

/**
 * Transport types supported by the server
 */
export enum TransportType {
  STDIO = "stdio",
  SSE = "sse",
  STREAMABLE_HTTP = "streamable-http",
}

/**
 * Transport Manager class
 */
export class TransportManager {
  private logger: Logger;
  private configManager: ConfigManager;
  private mcpServer: any;
  private transport: string;
  private streamableHttpTransports: Map<string, StreamableHTTPServerTransport> = new Map();

  constructor(
    logger: Logger,
    configManager: ConfigManager,
    mcpServer: any,
    transport: string
  ) {
    this.logger = logger;
    this.configManager = configManager;
    this.mcpServer = mcpServer;
    this.transport = transport;
  }

  /**
   * Determine transport from command line arguments or configuration
   */
  static determineTransport(
    args: string[],
    configManager: ConfigManager
  ): string {
    const transportArg = args.find((arg: string) =>
      arg.startsWith("--transport=")
    );
    if (transportArg) {
      return transportArg.split("=")[1];
    }
    const transport = configManager.getConfig().transports.default;
    if (transport === "sse") {
      return TransportType.STREAMABLE_HTTP;
    }
    return transport;
  }

  /**
   * Validate that the selected transport is enabled
   */
  validateTransport(): void {
    if (!this.configManager.isTransportEnabled(this.transport)) {
      throw new Error(
        `Transport '${this.transport}' is not enabled in the configuration`
      );
    }
  }

  /**
   * Setup STDIO transport
   */
  async setupStdioTransport(): Promise<void> {
    this.logger.info("Starting server with STDIO transport");

    // Create and configure the STDIO transport
    const stdioTransport = new StdioServerTransport();

    // Setup console redirection for STDIO mode
    this.setupStdioConsoleRedirection();

    // Setup STDIO event handlers
    this.setupStdioEventHandlers();

    // Connect the server to the transport
    try {
      await this.mcpServer.connect(stdioTransport);
      this.logger.info("STDIO transport connected successfully");
    } catch (error) {
      this.logger.error("Error connecting to STDIO transport:", error);
      process.exit(1);
    }
  }

  /**
   * Setup console redirection for STDIO transport
   */
  private setupStdioConsoleRedirection(): void {
    // Ensure we don't mix log messages with JSON messages
    console.log = (...args) => {
      this.logger.info("CONSOLE: " + args.join(" "));
    };

    console.error = (...args) => {
      this.logger.error("CONSOLE_ERROR: " + args.join(" "));
    };
  }

  /**
   * Setup STDIO event handlers
   */
  private setupStdioEventHandlers(): void {
    // Log when the stdin closes (which happens when the parent process terminates)
    process.stdin.on("end", () => {
      this.logger.info(
        "STDIN stream ended - parent process may have terminated"
      );
      process.exit(0);
    });
  }

  /**
   * Setup Streamable HTTP transport with Express integration
   */
  setupStreamableHttpTransport(app: express.Application): void {
    this.logger.info("Setting up Streamable HTTP transport endpoints");

    app.use(express.json());

    const handleSessionRequest = async (
      req: express.Request,
      res: express.Response
    ) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !this.streamableHttpTransports.has(sessionId)) {
        res.status(400).send("Invalid or missing session ID");
        return;
      }

      const transport = this.streamableHttpTransports.get(sessionId);
      if (transport) {
        await transport.handleRequest(req, res);
      }
    };

    app.post("/mcp", async (req: Request, res: Response) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && this.streamableHttpTransports.has(sessionId)) {
        transport = this.streamableHttpTransports.get(sessionId)!;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            this.streamableHttpTransports.set(newSessionId, transport);
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            this.streamableHttpTransports.delete(transport.sessionId);
          }
        };
        await this.mcpServer.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    });

    app.get("/mcp", handleSessionRequest);
    app.delete("/mcp", handleSessionRequest);
  }

  /**
   * Get transport type
   */
  getTransportType(): string {
    return this.transport;
  }

  /**
   * Check if transport is STDIO
   */
  isStdio(): boolean {
    return this.transport === TransportType.STDIO;
  }

  /**
   * Check if transport is SSE
   */
  isSse(): boolean {
    return this.transport === TransportType.SSE || this.transport === TransportType.STREAMABLE_HTTP;
  }

  /**
   * Get active SSE connections count
   */
  getActiveConnectionsCount(): number {
    return this.streamableHttpTransports.size;
  }

  /**
   * Close all active SSE connections
   */
  closeAllConnections(): void {
    this.logger.info(
      `Closing ${this.streamableHttpTransports.size} active Streamable HTTP connections`
    );
    this.streamableHttpTransports.forEach((transport) => transport.close());
    this.streamableHttpTransports.clear();
  }
}

/**
 * Create and configure a transport manager
 */
export function createTransportManager(
  logger: Logger,
  configManager: ConfigManager,
  mcpServer: any,
  transport: string
): TransportManager {
  const transportManager = new TransportManager(
    logger,
    configManager,
    mcpServer,
    transport
  );

  // Validate transport configuration
  transportManager.validateTransport();

  return transportManager;
}
