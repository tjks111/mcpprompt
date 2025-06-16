/**
 * Application Orchestration Module
 * Coordinates all modules and provides clean startup sequence
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "path";
import { fileURLToPath } from "url";

// Import all module managers
import { ApiManager, createApiManager } from "../api/index.js";
import { ConfigManager } from "../config/index.js";
import { createSimpleLogger, Logger } from "../logging/index.js";
import { createMcpToolsManager, McpToolsManager } from "../mcp-tools/index.js";
import { PromptManager } from "../prompts/index.js";
import { ServerManager, startMcpServer } from "../server/index.js";
import { TextReferenceManager } from "../text-references/index.js";
import {
  createTransportManager,
  TransportManager,
  TransportType,
} from "../transport/index.js";

// Import orchestration modules
import {
  ConversationManager,
  createConversationManager,
} from "./conversation-manager.js";
import { createPromptExecutor, PromptExecutor } from "./prompt-executor.js";

// Import types
import { Category, ConvertedPrompt, PromptData } from "../types/index.js";

/**
 * Application Orchestrator class
 * Coordinates all modules and manages application lifecycle
 */
export class ApplicationOrchestrator {
  private logger: Logger;
  private configManager: ConfigManager;
  private textReferenceManager: TextReferenceManager;
  private conversationManager: ConversationManager;
  private promptManager: PromptManager;
  private promptExecutor: PromptExecutor;
  private mcpToolsManager: McpToolsManager;
  private transportManager: TransportManager;
  private apiManager?: ApiManager;
  private serverManager?: ServerManager;

  // MCP Server instance
  private mcpServer: McpServer;

  // Application data
  private promptsData: PromptData[] = [];
  private categories: Category[] = [];
  private convertedPrompts: ConvertedPrompt[] = [];

  constructor() {
    // Will be initialized in startup()
    this.logger = null as any;
    this.configManager = null as any;
    this.textReferenceManager = null as any;
    this.conversationManager = null as any;
    this.promptManager = null as any;
    this.promptExecutor = null as any;
    this.mcpToolsManager = null as any;
    this.transportManager = null as any;
    this.mcpServer = null as any;
  }

  /**
   * Initialize all modules in the correct order
   */
  async startup(): Promise<void> {
    try {
      // Phase 1: Core Foundation
      await this.initializeFoundation();

      // Phase 2: Data Loading and Processing
      await this.loadAndProcessData();

      // Phase 3: Module Initialization
      await this.initializeModules();

      // Phase 4: Server Setup and Startup
      await this.startServer();

      this.logger.info(
        "Application orchestrator startup completed successfully"
      );
    } catch (error) {
      if (this.logger) {
        this.logger.error("Error during application startup:", error);
      } else {
        console.error("Error during application startup:", error);
      }
      throw error;
    }
  }

  /**
   * Determine the server root directory using multiple strategies
   * This is more robust for different execution contexts (direct execution vs Claude Desktop)
   */
  private async determineServerRoot(): Promise<string> {
    // Check for debug/verbose logging flags
    const args = process.argv.slice(2);
    const isVerbose =
      args.includes("--verbose") || args.includes("--debug-startup");
    const isQuiet = args.includes("--quiet");

    // Early termination: If environment variable is set, use it immediately
    if (process.env.MCP_SERVER_ROOT) {
      const envPath = path.resolve(process.env.MCP_SERVER_ROOT);
      try {
        const configPath = path.join(envPath, "config.json");
        const fs = await import("fs/promises");
        await fs.access(configPath);

        if (!isQuiet) {
          console.error(`✓ SUCCESS: MCP_SERVER_ROOT environment variable`);
          console.error(`  Path: ${envPath}`);
          console.error(`  Config found: ${configPath}`);
        }
        return envPath;
      } catch (error) {
        if (isVerbose) {
          console.error(`✗ WARNING: MCP_SERVER_ROOT env var set but invalid`);
          console.error(`  Tried path: ${envPath}`);
          console.error(
            `  Error: ${error instanceof Error ? error.message : String(error)}`
          );
          console.error(`  Falling back to automatic detection...`);
        }
      }
    }

    // Build strategies in optimal order (most likely to succeed first)
    const strategies = [];

    // Strategy 1: process.argv[1] script location (most successful in Claude Desktop)
    if (process.argv[1]) {
      const scriptPath = process.argv[1];

      // Primary strategy: Direct script location to server root
      strategies.push({
        name: "process.argv[1] script location",
        path: path.dirname(path.dirname(scriptPath)), // Go up from dist to server root
        source: `script: ${scriptPath}`,
        priority: "high",
      });

      // Secondary strategy: If we're specifically in a dist directory
      if (scriptPath.includes(path.sep + "dist" + path.sep)) {
        strategies.push({
          name: "process.argv[1] (dist-aware)",
          path: path.dirname(path.dirname(scriptPath)), // Fixed: go up 2 levels, not 3
          source: `script in dist: ${scriptPath}`,
          priority: "high",
        });
      }
    }

    // Strategy 2: import.meta.url (current module location) - reliable fallback
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    strategies.push({
      name: "import.meta.url relative",
      path: path.join(__dirname, "..", ".."),
      source: `module: ${__filename}`,
      priority: "medium",
    });

    // Strategy 3: Common Claude Desktop patterns (ordered by likelihood)
    const commonPaths = [
      { path: path.join(process.cwd(), "server"), desc: "cwd/server" },
      { path: process.cwd(), desc: "cwd" },
      { path: path.join(process.cwd(), "..", "server"), desc: "parent/server" },
      { path: path.join(__dirname, "..", "..", ".."), desc: "module parent" },
    ];

    for (const { path: commonPath, desc } of commonPaths) {
      strategies.push({
        name: `common pattern (${desc})`,
        path: commonPath,
        source: `pattern: ${commonPath}`,
        priority: "low",
      });
    }

    // Only show diagnostic information in verbose mode
    if (isVerbose) {
      console.error("=== SERVER ROOT DETECTION STRATEGIES ===");
      console.error(`Environment: process.cwd() = ${process.cwd()}`);
      console.error(`Environment: process.argv[0] = ${process.argv[0]}`);
      console.error(
        `Environment: process.argv[1] = ${process.argv[1] || "undefined"}`
      );
      console.error(
        `Environment: __filename = ${fileURLToPath(import.meta.url)}`
      );
      console.error(
        `Environment: MCP_SERVER_ROOT = ${
          process.env.MCP_SERVER_ROOT || "undefined"
        }`
      );
      console.error(`Strategies to test: ${strategies.length}`);
      console.error("");
    }

    // Test strategies with optimized flow
    let lastHighPriorityIndex = -1;
    for (let i = 0; i < strategies.length; i++) {
      const strategy = strategies[i];

      // Track where high-priority strategies end for early termination logic
      if (strategy.priority === "high") {
        lastHighPriorityIndex = i;
      }

      try {
        const resolvedPath = path.resolve(strategy.path);

        // Check if config.json exists in this location
        const configPath = path.join(resolvedPath, "config.json");
        const fs = await import("fs/promises");
        await fs.access(configPath);

        // Success! Only log if not in quiet mode
        if (!isQuiet) {
          console.error(`✓ SUCCESS: ${strategy.name}`);
          console.error(`  Path: ${resolvedPath}`);
          console.error(`  Source: ${strategy.source}`);
          console.error(`  Config found: ${configPath}`);

          // Show efficiency info in verbose mode
          if (isVerbose) {
            console.error(
              `  Strategy #${i + 1}/${strategies.length} (${
                strategy.priority
              } priority)`
            );
            console.error(
              `  Skipped ${strategies.length - i - 1} remaining strategies`
            );
          }
        }

        return resolvedPath;
      } catch (error) {
        // Only log failures in verbose mode
        if (isVerbose) {
          console.error(`✗ FAILED: ${strategy.name}`);
          console.error(`  Tried path: ${path.resolve(strategy.path)}`);
          console.error(`  Source: ${strategy.source}`);
          console.error(`  Priority: ${strategy.priority}`);
          console.error(
            `  Error: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        // Early termination: If all high-priority strategies fail and we're not in verbose mode,
        // provide a simplified error message encouraging environment variable usage
        if (
          i === lastHighPriorityIndex &&
          !isVerbose &&
          lastHighPriorityIndex >= 0
        ) {
          if (!isQuiet) {
            console.error(
              `⚠️  High-priority detection strategies failed. Trying fallback methods...`
            );
            console.error(
              `💡 Tip: Set MCP_SERVER_ROOT environment variable for instant detection`
            );
            console.error(`📝 Use --verbose to see detailed strategy testing`);
          }
        }
      }
    }

    // If all strategies fail, provide optimized troubleshooting information
    const attemptedPaths = strategies
      .map(
        (s, i) =>
          `  ${i + 1}. ${s.name} (${s.priority}): ${path.resolve(s.path)}`
      )
      .join("\n");

    const troubleshootingInfo = `
TROUBLESHOOTING CLAUDE DESKTOP ISSUES:

🎯 RECOMMENDED SOLUTION (fastest):
   Set MCP_SERVER_ROOT environment variable:
   Windows: set MCP_SERVER_ROOT=E:\\path\\to\\claude-prompts-mcp\\server
   macOS/Linux: export MCP_SERVER_ROOT=/path/to/claude-prompts-mcp/server

📁 Claude Desktop Configuration:
   Update your claude_desktop_config.json:
   {
     "mcpServers": {
       "claude-prompts-mcp": {
         "command": "node",
         "args": ["E:\\\\full\\\\path\\\\to\\\\server\\\\dist\\\\index.js", "--transport=stdio"],
         "env": {
           "MCP_SERVER_ROOT": "E:\\\\full\\\\path\\\\to\\\\server"
         }
       }
     }
   }

🔧 Alternative Solutions:
   1. Create wrapper script that sets working directory before launching server
   2. Use absolute paths in your Claude Desktop configuration
   3. Run from the correct working directory (server/)

🐛 Debug Mode:
   Use --verbose or --debug-startup flag to see detailed strategy testing

📊 Detection Summary:
   Current working directory: ${process.cwd()}
   Strategies tested (in order of priority):
${attemptedPaths}
`;

    console.error(troubleshootingInfo);

    throw new Error(
      `Unable to determine server root directory after testing ${strategies.length} strategies.\n\n` +
        `QUICK FIX: Set MCP_SERVER_ROOT environment variable to your server directory path.\n\n` +
        `See detailed troubleshooting information above.`
    );
  }

  /**
   * Phase 1: Initialize foundation (configuration, logging, basic services)
   */
  private async initializeFoundation(): Promise<void> {
    // Determine server root directory robustly
    const serverRoot = await this.determineServerRoot();

    // Initialize configuration manager using the detected server root
    const CONFIG_FILE = path.join(serverRoot, "config.json");
    this.configManager = new ConfigManager(CONFIG_FILE);
    await this.configManager.loadConfig();

    // Determine transport from command line arguments
    const args = process.argv.slice(2);
    const transport = TransportManager.determineTransport(
      args,
      this.configManager
    );

    // Check verbosity flags for conditional logging
    const isVerbose =
      args.includes("--verbose") || args.includes("--debug-startup");
    const isQuiet = args.includes("--quiet");

    // Initialize logger with verbosity awareness
    this.logger = createSimpleLogger(transport);

    // Only show startup messages if not in quiet mode
    if (!isQuiet) {
      this.logger.info("Starting MCP Claude Prompts Server...");
      this.logger.info(`Transport: ${transport}`);
    }

    // Verbose mode shows detailed configuration info
    if (isVerbose) {
      this.logger.info(`Server root: ${serverRoot}`);
      this.logger.info(`Config file: ${CONFIG_FILE}`);
      this.logger.debug(`Command line args: ${JSON.stringify(args)}`);
      this.logger.debug(`Process working directory: ${process.cwd()}`);
    }

    // Initialize text reference manager
    this.textReferenceManager = new TextReferenceManager(this.logger);

    // Initialize conversation manager
    this.conversationManager = createConversationManager(this.logger);

    // Create MCP server
    const config = this.configManager.getConfig();
    this.mcpServer = new McpServer({
      name: config.server.name,
      version: config.server.version,
      capabilities: {
        prompts: { listChanged: true },
        tools: true,
        // TODO: Add other capabilities if supported, e.g., for tools
      },
    });

    // Only log completion in verbose mode
    if (isVerbose) {
      this.logger.info("Foundation modules initialized");
    }
  }

  /**
   * Phase 2: Load and process prompt data
   */
  private async loadAndProcessData(): Promise<void> {
    // Check verbosity flags for conditional logging
    const args = process.argv.slice(2);
    const isVerbose =
      args.includes("--verbose") || args.includes("--debug-startup");
    const isQuiet = args.includes("--quiet");

    // Initialize prompt manager
    this.promptManager = new PromptManager(
      this.logger,
      this.textReferenceManager,
      this.configManager,
      this.mcpServer
    );

    // Load and convert prompts with enhanced path resolution
    const config = this.configManager.getConfig();

    // ENHANCED: Allow direct prompts config path override via environment variable
    // This bypasses server root detection issues entirely and is perfect for Claude Desktop
    let PROMPTS_FILE: string;

    if (process.env.MCP_PROMPTS_CONFIG_PATH) {
      PROMPTS_FILE = process.env.MCP_PROMPTS_CONFIG_PATH;
      if (isVerbose) {
        this.logger.info(
          "🎯 Using MCP_PROMPTS_CONFIG_PATH environment variable override"
        );
      }
    } else {
      // Fallback to ConfigManager's getPromptsFilePath() method
      PROMPTS_FILE = this.configManager.getPromptsFilePath();
      if (isVerbose) {
        this.logger.info("📁 Using config-based prompts file path resolution");
      }
    }

    // Enhanced logging for prompt loading pipeline (verbose mode only)
    if (isVerbose) {
      this.logger.info("=== PROMPT LOADING PIPELINE START ===");
      this.logger.info(`Config prompts.file setting: "${config.prompts.file}"`);
      if (process.env.MCP_PROMPTS_CONFIG_PATH) {
        this.logger.info(
          `🎯 MCP_PROMPTS_CONFIG_PATH override: "${process.env.MCP_PROMPTS_CONFIG_PATH}"`
        );
      } else {
        this.logger.info(
          `Config manager base directory: "${path.dirname(
            this.configManager.getPromptsFilePath()
          )}"`
        );
      }
      this.logger.info(`✅ Final PROMPTS_FILE path: "${PROMPTS_FILE}"`);

      // Add additional diagnostic information
      this.logger.info("=== PATH RESOLUTION DIAGNOSTICS ===");
      this.logger.info(`process.cwd(): ${process.cwd()}`);
      this.logger.info(`process.argv[0]: ${process.argv[0]}`);
      this.logger.info(`process.argv[1]: ${process.argv[1] || "undefined"}`);
      this.logger.info(
        `__filename equivalent: ${fileURLToPath(import.meta.url)}`
      );
      this.logger.info(
        `Config file path: ${(this.configManager as any).configPath}`
      );
      this.logger.info(
        `MCP_PROMPTS_CONFIG_PATH: ${
          process.env.MCP_PROMPTS_CONFIG_PATH || "undefined"
        }`
      );
      this.logger.info(
        `MCP_SERVER_ROOT: ${process.env.MCP_SERVER_ROOT || "undefined"}`
      );
      this.logger.info(
        `PROMPTS_FILE is absolute: ${path.isAbsolute(PROMPTS_FILE)}`
      );
      this.logger.info(
        `PROMPTS_FILE normalized: ${path.normalize(PROMPTS_FILE)}`
      );
    }

    // Validate that we're using absolute paths (critical for Claude Desktop)
    if (!path.isAbsolute(PROMPTS_FILE)) {
      if (isVerbose) {
        this.logger.error(
          `⚠️  CRITICAL: PROMPTS_FILE is not absolute: ${PROMPTS_FILE}`
        );
        this.logger.error(
          `This will cause issues with Claude Desktop execution!`
        );
      }
      // Convert to absolute path as fallback
      // Use serverRoot which is determined earlier and more reliable for constructing the absolute path
      const serverRoot = await this.determineServerRoot(); // Ensure serverRoot is available
      const absolutePromptsFile = path.resolve(serverRoot, PROMPTS_FILE);
      if (isVerbose) {
        this.logger.info(
          `🔧 Converting to absolute path: ${absolutePromptsFile}`
        );
      }
      PROMPTS_FILE = absolutePromptsFile;
    }

    // Verify the file exists before attempting to load
    try {
      const fs = await import("fs/promises");
      await fs.access(PROMPTS_FILE);
      if (isVerbose) {
        this.logger.info(
          `✓ Prompts configuration file exists: ${PROMPTS_FILE}`
        );
      }
    } catch (error) {
      this.logger.error(
        `✗ Prompts configuration file NOT FOUND: ${PROMPTS_FILE}`
      );
      if (isVerbose) {
        this.logger.error(`File access error:`, error);

        // Provide additional troubleshooting information
        this.logger.error("=== TROUBLESHOOTING INFORMATION ===");
        this.logger.error(`Is path absolute? ${path.isAbsolute(PROMPTS_FILE)}`);
        this.logger.error(`Normalized path: ${path.normalize(PROMPTS_FILE)}`);
        this.logger.error(`Path exists check: ${PROMPTS_FILE}`);
      }

      throw new Error(`Prompts configuration file not found: ${PROMPTS_FILE}`);
    }

    try {
      this.logger.info("Initiating prompt loading and conversion...");
      // Pass path.dirname(PROMPTS_FILE) as the basePath for resolving relative prompt file paths
      const result = await this.promptManager.loadAndConvertPrompts(
        PROMPTS_FILE,
        path.dirname(PROMPTS_FILE)
      );

      this.promptsData = result.promptsData;
      this.categories = result.categories;
      this.convertedPrompts = result.convertedPrompts;

      this.logger.info("=== PROMPT LOADING RESULTS ===");
      this.logger.info(
        `✓ Loaded ${this.promptsData.length} prompts from ${this.categories.length} categories`
      );
      this.logger.info(
        `✓ Converted ${this.convertedPrompts.length} prompts to MCP format`
      );

      // Log category breakdown
      if (this.categories.length > 0) {
        this.logger.info("Categories loaded:");
        this.categories.forEach((category) => {
          const categoryPrompts = this.promptsData.filter(
            (p) => p.category === category.id
          );
          this.logger.info(
            `  - ${category.name} (${category.id}): ${categoryPrompts.length} prompts`
          );
        });
      } else {
        this.logger.warn("⚠ No categories were loaded!");
      }

      this.logger.info("=== PROMPT LOADING PIPELINE END ===");

      // BEGIN ADDED CODE
    // Propagate updated data to other relevant managers
    // (This might already be happening if these managers fetch data on demand or are updated elsewhere,
    // but explicit updates ensure consistency after a hot-reload)
    if (this.mcpToolsManager) {
      this.mcpToolsManager.updateData(
        this.promptsData,
        this.convertedPrompts,
        this.categories
      );
    }
    if (this.promptExecutor) {
      this.promptExecutor.updatePrompts(this.convertedPrompts);
    }

      // CRUCIAL STEP: Re-register all prompts with the McpServer using the newly loaded data
      // if (this.promptManager && this.mcpServer) {
      //   this.logger.info(
      //     "🔄 Re-registering all prompts with MCP server after hot-reload..."
      //   );
      //   const registeredCount = await this.promptManager.registerAllPrompts(
      //     this.convertedPrompts
      //   );
      //   this.logger.info(
      //     `✅ Successfully re-registered ${registeredCount} prompts.`
      //   );
      // } else {
      //   this.logger.warn(
      //     "⚠️ PromptManager or McpServer not available, skipping re-registration of prompts after hot-reload."
      //   );
      // }
    } catch (error) {
      this.logger.error("✗ PROMPT LOADING FAILED:");
      this.logger.error("Error details:", error);
      this.logger.error(
        "Stack trace:",
        error instanceof Error ? error.stack : "No stack trace available"
      );
      throw error;
    }
  }

  /**
   * Phase 3: Initialize remaining modules with loaded data
   */
  private async initializeModules(): Promise<void> {
    // Initialize prompt executor
    this.promptExecutor = createPromptExecutor(
      this.logger,
      this.promptManager,
      this.conversationManager
    );
    this.promptExecutor.updatePrompts(this.convertedPrompts);

    // Initialize MCP tools manager
    this.mcpToolsManager = createMcpToolsManager(
      this.logger,
      this.mcpServer,
      this.promptManager,
      this.configManager,
      () => this.fullServerRefresh(),
      (reason: string) => this.restartServer(reason)
    );

    // Update MCP tools manager with current data
    this.mcpToolsManager.updateData(
      this.promptsData,
      this.convertedPrompts,
      this.categories
    );

    // Register all MCP tools
    await this.mcpToolsManager.registerAllTools();

    // Register all prompts
    await this.promptManager.registerAllPrompts(this.convertedPrompts);

    this.logger.info("All modules initialized successfully");
  }

  /**
   * Phase 4: Setup and start the server
   */
  private async startServer(): Promise<void> {
    // Determine transport
    const args = process.argv.slice(2);
    const transport = TransportManager.determineTransport(
      args,
      this.configManager
    );

    // Create transport manager
    this.transportManager = createTransportManager(
      this.logger,
      this.configManager,
      this.mcpServer,
      transport
    );

    // Create API manager for Streamable HTTP transport
    if (this.transportManager.getTransportType() === "streamable-http") {
      this.apiManager = createApiManager(
        this.logger,
        this.configManager,
        this.promptManager,
        this.mcpToolsManager
      );

      // Update API manager with current data
      this.apiManager.updateData(
        this.promptsData,
        this.categories,
        this.convertedPrompts
      );
    }

    // Start the server
    this.serverManager = await startMcpServer(
      this.logger,
      this.configManager,
      this.transportManager,
      this.apiManager
    );

    this.logger.info("Server started successfully");
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    try {
      if (this.logger) {
        this.logger.info("Initiating application shutdown...");
      }

      if (this.serverManager) {
        this.serverManager.shutdown();
      }

      if (this.logger) {
        this.logger.info("Application shutdown completed");
      }
    } catch (error) {
      if (this.logger) {
        this.logger.error("Error during shutdown:", error);
      } else {
        console.error("Error during shutdown (logger not available):", error);
      }
      throw error;
    }
  }

  /**
   * Perform a full server refresh (hot-reload).
   * This reloads all prompts from disk and updates all relevant modules.
   */
  public async fullServerRefresh(): Promise<void> {
    this.logger.info(
      "🔥 Orchestrator: Starting full server refresh (hot-reload)..."
    );
    try {
      // Step 1: Reload all prompt data from disk by re-running the data loading phase.
      // This updates the orchestrator's internal state with the latest file contents.
      await this.loadAndProcessData();
      this.logger.info("✅ Data reloaded and processed from disk.");

      // Step 2: Propagate the new data to all dependent modules.
      // This ensures all parts of the application are synchronized with the new state.
      this.promptExecutor.updatePrompts(this.convertedPrompts);
      this.logger.info("✅ PromptExecutor updated with new prompts.");

      if (this.mcpToolsManager) {
        this.mcpToolsManager.updateData(
          this.promptsData,
          this.convertedPrompts,
          this.categories
        );
        this.logger.info("✅ McpToolsManager updated with new data.");
      }


      // Step 3: Re-register the newly loaded prompts with the running MCP server instance.
      // This makes the new/updated prompts available for execution immediately.
      await this.promptManager.registerAllPrompts(this.convertedPrompts);
      this.logger.info("✅ Prompts re-registered with MCP Server.");

      this.logger.info("🚀 Full server refresh completed successfully.");
    } catch (error) {
      this.logger.error("❌ Error during full server refresh:", error);
      // Re-throw the error so the caller can handle it appropriately.
      throw error;
    }
  }

  /**
   * Restart the application by shutting down and exiting with a restart code.
   * Relies on a process manager (e.g., PM2) to restart the process.
   */
  public async restartServer(reason: string = "Manual restart"): Promise<void> {
    this.logger.info(`🚨 Initiating server restart. Reason: ${reason}`);
    try {
      // Ensure all current operations are gracefully shut down.
      await this.shutdown();
      this.logger.info(
        "✅ Server gracefully shut down. Exiting with restart code."
      );
    } catch (error) {
      this.logger.error("❌ Error during pre-restart shutdown:", error);
    } finally {
      // Exit with a specific code that a process manager can detect.
      process.exit(100);
    }
  }

  /**
   * Get application status
   */
  getStatus(): {
    running: boolean;
    transport?: string;
    promptsLoaded: number;
    categoriesLoaded: number;
    serverStatus?: any;
  } {
    return {
      running: this.serverManager?.isRunning() || false,
      transport: this.transportManager?.getTransportType(),
      promptsLoaded: this.promptsData.length,
      categoriesLoaded: this.categories.length,
      serverStatus: this.serverManager?.getStatus(),
    };
  }

  /**
   * Get all module instances (for debugging/testing)
   */
  getModules() {
    return {
      logger: this.logger,
      configManager: this.configManager,
      promptManager: this.promptManager,
      textReferenceManager: this.textReferenceManager,
      conversationManager: this.conversationManager,
      promptExecutor: this.promptExecutor,
      mcpToolsManager: this.mcpToolsManager,
      apiManager: this.apiManager,
      serverManager: this.serverManager,
    };
  }

  /**
   * Validate application health - comprehensive health check
   */
  validateHealth(): {
    healthy: boolean;
    modules: {
      foundation: boolean;
      dataLoaded: boolean;
      modulesInitialized: boolean;
      serverRunning: boolean;
    };
    details: {
      promptsLoaded: number;
      categoriesLoaded: number;
      serverStatus?: any;
      moduleStatus: Record<string, boolean>;
    };
    issues: string[];
  } {
    const issues: string[] = [];
    const moduleStatus: Record<string, boolean> = {};

    // Check foundation modules
    const foundationHealthy = !!(
      this.logger &&
      this.configManager &&
      this.textReferenceManager
    );
    moduleStatus.foundation = foundationHealthy;
    if (!foundationHealthy) {
      issues.push("Foundation modules not properly initialized");
    }

    // Check data loading
    const dataLoaded =
      this.promptsData.length > 0 && this.categories.length > 0;
    moduleStatus.dataLoaded = dataLoaded;
    if (!dataLoaded) {
      issues.push("Prompt data not loaded or empty");
    }

    // Check module initialization
    const modulesInitialized = !!(
      this.promptManager &&
      this.promptExecutor &&
      this.mcpToolsManager
    );
    moduleStatus.modulesInitialized = modulesInitialized;
    moduleStatus.serverRunning = !!(
      this.serverManager && this.transportManager
    );

    moduleStatus.configManager = !!this.configManager;
    moduleStatus.logger = !!this.logger;
    moduleStatus.promptManager = !!this.promptManager;
    moduleStatus.textReferenceManager = !!this.textReferenceManager;
    moduleStatus.conversationManager = !!this.conversationManager;
    moduleStatus.promptExecutor = !!this.promptExecutor;
    moduleStatus.mcpToolsManager = !!this.mcpToolsManager;
    moduleStatus.transportManager = !!this.transportManager;
    moduleStatus.serverManager = !!this.serverManager;

    // Check overall health
    const isHealthy =
      foundationHealthy &&
      dataLoaded &&
      modulesInitialized &&
      moduleStatus.serverRunning &&
      issues.length === 0;

    return {
      healthy: isHealthy,
      modules: {
        foundation: foundationHealthy,
        dataLoaded,
        modulesInitialized,
        serverRunning: moduleStatus.serverRunning,
      },
      details: {
        promptsLoaded: this.promptsData.length,
        categoriesLoaded: this.categories.length,
        serverStatus: this.serverManager?.getStatus(),
        moduleStatus,
      },
      issues,
    };
  }

  /**
   * Get performance metrics for monitoring
   */
  getPerformanceMetrics(): {
    uptime: number;
    memoryUsage: NodeJS.MemoryUsage;
    process: {
      pid: number;
      nodeVersion: string;
      platform: string;
      arch: string;
    };
    application: {
      promptsLoaded: number;
      categoriesLoaded: number;
      serverConnections?: number;
    };
  } {
    return {
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      process: {
        pid: process.pid,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      application: {
        promptsLoaded: this.promptsData.length,
        categoriesLoaded: this.categories.length,
        serverConnections: this.transportManager?.isSse()
          ? this.transportManager.getActiveConnectionsCount()
          : undefined,
      },
    };
  }

  /**
   * Emergency diagnostic information for troubleshooting
   */
  getDiagnosticInfo(): {
    timestamp: string;
    health: ReturnType<ApplicationOrchestrator["validateHealth"]>;
    performance: ReturnType<ApplicationOrchestrator["getPerformanceMetrics"]>;
    configuration: {
      transport: string;
      configLoaded: boolean;
    };
    errors: string[];
  } {
    const errors: string[] = [];

    try {
      // Collect any recent errors or issues
      if (!this.mcpServer) {
        errors.push("MCP Server instance not available");
      }

      if (this.promptsData.length === 0) {
        errors.push("No prompts loaded");
      }

      if (this.categories.length === 0) {
        errors.push("No categories loaded");
      }

      return {
        timestamp: new Date().toISOString(),
        health: this.validateHealth(),
        performance: this.getPerformanceMetrics(),
        configuration: {
          transport: this.transportManager?.getTransportType() || "unknown",
          configLoaded: !!this.configManager,
        },
        errors,
      };
    } catch (error) {
      errors.push(
        `Error collecting diagnostic info: ${
          error instanceof Error ? error.message : String(error)
        }`
      );

      return {
        timestamp: new Date().toISOString(),
        health: {
          healthy: false,
          modules: {
            foundation: false,
            dataLoaded: false,
            modulesInitialized: false,
            serverRunning: false,
          },
          details: { promptsLoaded: 0, categoriesLoaded: 0, moduleStatus: {} },
          issues: ["Failed to collect health information"],
        },
        performance: {
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage(),
          process: {
            pid: process.pid,
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
          },
          application: { promptsLoaded: 0, categoriesLoaded: 0 },
        },
        configuration: {
          transport: "unknown",
          configLoaded: false,
        },
        errors,
      };
    }
  }
}

/**
 * Create and configure an application orchestrator
 */
export function createApplicationOrchestrator(): ApplicationOrchestrator {
  return new ApplicationOrchestrator();
}

/**
 * Main application entry point
 */
export async function startApplication(): Promise<ApplicationOrchestrator> {
  const orchestrator = createApplicationOrchestrator();
  await orchestrator.startup();
  return orchestrator;
}
