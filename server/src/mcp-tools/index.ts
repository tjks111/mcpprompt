/**
 * MCP Tools Module
 * Handles registration and implementation of MCP tools for the server
 */

import { z } from "zod";
import { ConfigManager } from "../config/index.js";
import { Logger } from "../logging/index.js";
import { PromptManager } from "../prompts/index.js";
import {
  Category,
  ConvertedPrompt,
  PromptData,
  ToolResponse,
} from "../types/index.js";
import {
  PromptError,
  handleError as utilsHandleError,
  validateJsonArguments,
  ValidationError,
} from "../utils/index.js";
import { PromptManagementTools } from "./prompt-management-tools.js";

/**
 * MCP Tools Manager class
 */
export class McpToolsManager {
  private logger: Logger;
  private mcpServer: any;
  private promptManager: PromptManager;
  private configManager: ConfigManager;
  private promptManagementTools: PromptManagementTools;
  private promptsData: PromptData[] = [];
  private convertedPrompts: ConvertedPrompt[] = [];
  private categories: Category[] = [];

  constructor(
    logger: Logger,
    mcpServer: any,
    promptManager: PromptManager,
    configManager: ConfigManager,
    onRefresh: () => Promise<void>,
    onRestart: (reason: string) => Promise<void>
  ) {
    this.logger = logger;
    this.mcpServer = mcpServer;
    this.promptManager = promptManager;
    this.configManager = configManager;
    this.promptManagementTools = new PromptManagementTools(
      logger,
      mcpServer,
      configManager,
      onRefresh,
      onRestart
    );
  }

  /**
   * Register all MCP tools with the server
   */
  async registerAllTools(): Promise<void> {
    this.logger.info("Registering MCP tools with server...");

    // Register each tool
    this.registerProcessSlashCommand();
    this.registerListPrompts();
    this.promptManagementTools.registerUpdatePrompt();
    this.promptManagementTools.registerDeletePrompt();
    this.promptManagementTools.registerModifyPromptSection();
    this.promptManagementTools.registerReloadPrompts();

    this.logger.info("All MCP tools registered successfully");
  }

  /**
   * Get a list of all registered tools from the MCP server instance.
   */
  public async getRegisteredTools(): Promise<any[]> {
    // This method retrieves all tools registered with the MCP server.
    if (!this.mcpServer) {
      this.logger.warn("MCP Server instance not available in McpToolsManager.");
      return [];
    }
    try {
      const tools = await this.mcpServer.listTools();
      this.logger.debug(`Retrieved ${tools.length} registered tools.`);
      return tools;
    } catch (error) {
      this.logger.error("Error listing registered tools:", error);
      return [];
    }
  }

  /**
   * Update internal data references
   */
  updateData(
    promptsData: PromptData[],
    convertedPrompts: ConvertedPrompt[],
    categories: Category[]
  ): void {
    this.promptsData = promptsData;
    this.convertedPrompts = convertedPrompts;
    this.categories = categories;
    this.promptManagementTools.updateData(promptsData, convertedPrompts);
  }

  /**
   * Register process_slash_command tool
   */
  private registerProcessSlashCommand(): void {
    this.mcpServer.tool(
      "process_slash_command",
      "Process commands that trigger prompt templates with optional arguments",
      {
        command: z
          .string()
          .describe(
            "The command to process, e.g., '>>content_analysis Hello world' or '/content_analysis Hello world'"
          ),
      },
      async ({ command }: { command: string }, extra: any) => {
        try {
          this.logger.info(`Processing command: ${command}`);

          // Extract the command name and arguments
          const match = command.match(/^(>>|\/)([a-zA-Z0-9_-]+)\s*(.*)/);

          if (!match) {
            throw new ValidationError(
              "Invalid command format. Use >>command_name [arguments] or /command_name [arguments]"
            );
          }

          const [, prefix, commandName, commandArgs] = match;

          // Find the matching prompt (PromptData)
          const matchingPrompt = this.promptsData.find(
            (prompt) => prompt.id === commandName || prompt.name === commandName
          );

          if (!matchingPrompt) {
            throw new PromptError(
              `Unknown command: ${prefix}${commandName}. Type >>listprompts to see available commands.`
            );
          }

          // Find the corresponding ConvertedPrompt to access onEmptyInvocation
          const convertedPrompt = this.convertedPrompts.find(
            (cp) => cp.id === matchingPrompt.id
          );

          if (!convertedPrompt) {
            // This should ideally not happen if promptsData and convertedPrompts are in sync
            throw new PromptError(
              `Could not find converted prompt data for ${matchingPrompt.id}. Server data might be inconsistent.`
            );
          }

          // Check if commandArgs is empty and how to handle it
          const trimmedCommandArgs = commandArgs.trim();

          if (
            trimmedCommandArgs === "" &&
            convertedPrompt.onEmptyInvocation === "return_template"
          ) {
            this.logger.info(
              `Command '${prefix}${commandName}' invoked without arguments and onEmptyInvocation is 'return_template'. Returning template info.`
            );

            let responseText = `Prompt: '${convertedPrompt.name}' (ID: ${convertedPrompt.id})\n`;
            responseText += `Description: ${convertedPrompt.description}\n`;

            if (
              convertedPrompt.arguments &&
              convertedPrompt.arguments.length > 0
            ) {
              responseText += `This prompt requires the following arguments:\n`;
              convertedPrompt.arguments.forEach((arg) => {
                responseText += `  - ${arg.name}${
                  arg.required ? " (required)" : " (optional)"
                }: ${arg.description || "No description"}\n`;
              });
              responseText += `\nExample usage: ${prefix}${
                convertedPrompt.id || convertedPrompt.name
              } ${convertedPrompt.arguments
                .map((arg) => `${arg.name}=\"value\"`)
                .join(" ")}`;
            } else {
              responseText += "This prompt does not require any arguments.\n";
            }
            return {
              content: [{ type: "text" as const, text: responseText }],
              isError: false,
            };
          }

          // Parse arguments if commandArgs is not empty, or if it's empty but onEmptyInvocation is 'execute_if_possible'
          const promptArgValues: Record<string, string> = {};

          // Only call parseCommandArguments if there are actual commandArgs to parse
          // If commandArgs is empty and onEmptyInvocation is 'execute_if_possible',
          // the subsequent logic will fill them with {{previous_message}}
          if (trimmedCommandArgs !== "") {
            this.parseCommandArguments(
              trimmedCommandArgs, // Use trimmed version
              matchingPrompt, // parseCommandArguments expects PromptData
              promptArgValues,
              prefix,
              commandName
            );
          }

          // Ensure all defined arguments have values (fills with {{previous_message}} if not provided)
          matchingPrompt.arguments.forEach((arg) => {
            if (!promptArgValues[arg.name]) {
              promptArgValues[arg.name] = `{{previous_message}}`;
            }
          });

          // Handle chain prompts differently
          if (convertedPrompt.isChain) {
            return this.handleChainPrompt(convertedPrompt);
          }

          // Process regular prompt
          return await this.processRegularPrompt(
            convertedPrompt,
            promptArgValues
          );
        } catch (error) {
          const { message, isError } = this.handleError(
            error,
            "Error processing command"
          );
          return {
            content: [{ type: "text", text: message }],
            isError,
          };
        }
      }
    );
  }

  /**
   * Parse command arguments
   */
  private parseCommandArguments(
    commandArgs: string,
    matchingPrompt: PromptData,
    promptArgValues: Record<string, string>,
    prefix: string,
    commandName: string
  ): void {
    if (matchingPrompt.arguments.length === 0) {
      this.logger.warn(
        `Command '${prefix}${commandName}' doesn't accept arguments, but arguments were provided: ${commandArgs}`
      );
    } else if (
      matchingPrompt.arguments.length === 1 &&
      (!commandArgs.trim().startsWith("{") || !commandArgs.trim().endsWith("}"))
    ) {
      // Single argument, not in JSON format
      promptArgValues[matchingPrompt.arguments[0].name] = commandArgs.trim();
    } else {
      try {
        if (
          commandArgs.trim().startsWith("{") &&
          commandArgs.trim().endsWith("}")
        ) {
          const parsedArgs = JSON.parse(commandArgs);
          const validation = validateJsonArguments(parsedArgs, matchingPrompt);

          if (!validation.valid && validation.errors) {
            this.logger.warn(
              `Invalid arguments for ${prefix}${commandName}: ${validation.errors.join(
                ", "
              )}. Using previous message instead.`
            );
            matchingPrompt.arguments.forEach((arg) => {
              promptArgValues[arg.name] = `{{previous_message}}`;
            });
          } else {
            Object.assign(promptArgValues, validation.sanitizedArgs || {});
          }
        } else if (matchingPrompt.arguments.length === 1) {
          promptArgValues[matchingPrompt.arguments[0].name] = commandArgs;
        } else {
          this.logger.warn(
            `Multi-argument prompt requested (${matchingPrompt.arguments.length} args). Command arguments not in JSON format. Using previous message instead.`
          );
          matchingPrompt.arguments.forEach((arg) => {
            promptArgValues[arg.name] = `{{previous_message}}`;
          });
        }
      } catch (e) {
        this.logger.warn(
          `Error parsing arguments for ${prefix}${commandName}: ${
            e instanceof Error ? e.message : String(e)
          }. Using previous message instead.`
        );
        matchingPrompt.arguments.forEach((arg) => {
          promptArgValues[arg.name] = `{{previous_message}}`;
        });
      }
    }
  }

  /**
   * Handle chain prompt execution
   */
  private handleChainPrompt(convertedPrompt: ConvertedPrompt): ToolResponse {
    const chainSteps = convertedPrompt.chainSteps || [];

    const chainExplanation = [
      `This is a prompt chain: ${convertedPrompt.name} (${convertedPrompt.id})`,
      `It consists of ${chainSteps.length} steps that should be executed in sequence:`,
      ...chainSteps.map(
        (step: any, index: number) =>
          `${index + 1}. ${step.stepName} (${step.promptId})`
      ),
      `\nTo execute this chain, run each step in sequence using the '>>' or '/' command syntax:`,
      ...chainSteps.map(
        (step: any, index: number) =>
          `${index + 1}. >>${step.promptId} [with appropriate arguments]`
      ),
      `\nEach step will use outputs from previous steps as inputs for the next step.`,
    ].join("\n");

    return {
      content: [{ type: "text", text: chainExplanation }],
    };
  }

  /**
   * Process regular (non-chain) prompt
   */
  private async processRegularPrompt(
    convertedPrompt: ConvertedPrompt,
    promptArgValues: Record<string, string>
  ): Promise<ToolResponse> {
    let userMessageText = convertedPrompt.userMessageTemplate;

    // Add system message if present
    if (convertedPrompt.systemMessage) {
      userMessageText = `[System Info: ${convertedPrompt.systemMessage}]\n\n${userMessageText}`;
    }

    // Process the template to replace all placeholders, passing the tools flag
    userMessageText = await this.promptManager.processTemplateAsync(
      userMessageText,
      promptArgValues,
      { previous_message: "{{previous_message}}" },
      convertedPrompt.tools || false
    );

    return {
      content: [{ type: "text", text: userMessageText }],
    };
  }

  /**
   * Register listprompts tool
   */
  private registerListPrompts(): void {
    this.mcpServer.tool(
      "listprompts",
      {
        command: z
          .string()
          .optional()
          .describe("Optional filter text to show only matching commands"),
      },
      async ({ command }: { command?: string }, extra: any) => {
        try {
          const match = command
            ? command.match(/^(>>|\/)listprompts\s*(.*)/)
            : null;
          const filterText = match ? match[2].trim() : "";

          return this.generatePromptsList(filterText);
        } catch (error) {
          this.logger.error("Error executing listprompts command:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error displaying listprompts: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              },
            ],
            isError: true,
          };
        }
      }
    );
  }

  /**
   * Generate formatted prompts list
   */
  private generatePromptsList(filterText: string = ""): ToolResponse {
    let listpromptsText = "# Available Commands\n\n";

    // Group prompts by category
    const promptsByCategory: Record<string, ConvertedPrompt[]> = {};
    const categoryMap: Record<string, string> = {};

    this.categories.forEach((cat) => {
      categoryMap[cat.id] = cat.name;
      promptsByCategory[cat.id] = [];
    });

    this.convertedPrompts.forEach((prompt) => {
      if (!promptsByCategory[prompt.category]) {
        promptsByCategory[prompt.category] = [];
      }
      promptsByCategory[prompt.category].push(prompt);
    });

    // Add each category and its prompts
    Object.entries(promptsByCategory).forEach(([categoryId, prompts]) => {
      if (prompts.length === 0) return;

      const categoryName = categoryMap[categoryId] || categoryId;
      listpromptsText += `## ${categoryName}\n\n`;

      prompts.forEach((prompt) => {
        listpromptsText += `### /${prompt.id}\n`;
        if (prompt.name !== prompt.id) {
          listpromptsText += `*Alias: /${prompt.name}*\n\n`;
        } else {
          listpromptsText += "\n";
        }

        listpromptsText += `${prompt.description}\n\n`;

        if (prompt.arguments.length > 0) {
          listpromptsText += "**Arguments:**\n\n";

          prompt.arguments.forEach((arg) => {
            listpromptsText += `- \`${arg.name}\` (optional): ${
              arg.description || "No description"
            }\n`;
          });

          listpromptsText += "\n**Usage:**\n\n";

          if (prompt.arguments.length === 1) {
            const argName = prompt.arguments[0].name;
            listpromptsText += `\`/${prompt.id} your ${argName} here\`\n\n`;
          } else if (prompt.arguments.length > 1) {
            const exampleArgs: Record<string, string> = {};
            prompt.arguments.forEach((arg) => {
              exampleArgs[arg.name] = `<your ${arg.name} here>`;
            });
            listpromptsText += `\`/${prompt.id} ${JSON.stringify(
              exampleArgs
            )}\`\n\n`;
          }
        }
      });
    });

    // Special commands
    listpromptsText += "## Special Commands\n\n";
    listpromptsText += "### >>listprompts\n\n";
    listpromptsText += "Lists all available commands and their usage.\n\n";
    listpromptsText += "**Usage:** `>>listprompts` or `/listprompts`\n\n";

    return {
      content: [{ type: "text", text: listpromptsText }],
    };
  }

  /**
   * Error handling helper
   */
  private handleError(
    error: unknown,
    context: string
  ): { message: string; isError: boolean } {
    return utilsHandleError(error, context, this.logger);
  }
}

/**
 * Create and configure MCP tools manager
 */
export function createMcpToolsManager(
  logger: Logger,
  mcpServer: any,
  promptManager: PromptManager,
  configManager: ConfigManager,
  onRefresh: () => Promise<void>,
  onRestart: (reason: string) => Promise<void>
): McpToolsManager {
  return new McpToolsManager(
    logger,
    mcpServer,
    promptManager,
    configManager,
    onRefresh,
    onRestart
  );
}
