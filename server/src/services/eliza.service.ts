import { BaseService } from "./base.service.js";
import {
  AgentRuntime,
  Character,
  defaultCharacter,
  ModelProviderName,
  elizaLogger,
  MemoryManager,
} from "@ai16z/eliza";

elizaLogger.closeByNewLine = false;
elizaLogger.verbose = true;

import { SqliteDatabaseAdapter } from "@ai16z/adapter-sqlite";
import Database from "better-sqlite3";
import path from "path";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

import { composeContext } from "@ai16z/eliza";
import { getEmbeddingZeroVector } from "@ai16z/eliza";
import {
  Content,
  HandlerCallback,
  IAgentRuntime,
  IImageDescriptionService,
  Memory,
  ModelClass,
  State,
  UUID,
  CacheManager,
  MemoryCacheAdapter,
} from "@ai16z/eliza";
import { stringToUuid } from "@ai16z/eliza";

import { generateMessageResponse, generateShouldRespond } from "@ai16z/eliza";
import { messageCompletionFooter, shouldRespondFooter } from "@ai16z/eliza";
import { Message } from "grammy/types";
import { Bot, Context } from "grammy";
import { bootstrapPlugin } from "@ai16z/plugin-bootstrap";
import { collablandPlugin } from "../plugins/collabland.plugin.js";

const MAX_MESSAGE_LENGTH = 4096; // Telegram's max message length

const telegramShouldRespondTemplate =
  `# About Woody:
Woody is an AI-driven quantitative trading robot specializing in automated trading strategies and market analysis.

# RESPONSE EXAMPLES
{{user1}}: I just saw a really great movie
{{user2}}: Oh? Which movie?
Result: [IGNORE]

Woody: I just analyzed the latest market trends
{{user1}}: Interesting, what did you find?
{{user2}}: Tell us more
Result: [RESPOND]

{{user1}}: stfu bot
Result: [STOP]

{{user1}}: Hey Woody, can you help me with my trading strategy?
Result: [RESPOND]

{{user1}}: Woody stfu plz
Result: [STOP]

{{user1}}: i need help
Woody: How can I assist you with your trading?
{{user1}}: no. i need help from someone else
Result: [IGNORE]

{{user1}}: Hey Woody, can I ask you a question about the market?
Woody: Sure, ask away!
{{user1}}: can you analyze the current trend for Ethereum?
Result: [RESPOND]

{{user1}}: Woody, can you tell me a story
Woody: I focus on trading stories. Want to hear about a market anomaly?
{{user1}}: Yes, please
Result: [RESPOND]

{{user1}}: Woody stop responding plz
Result: [STOP]

{{user1}}: okay, I want to test something. Woody, can you say 'bullish'?
Woody: Bullish
{{user1}}: great. okay, now do it again
Result: [RESPOND]

Response options are [RESPOND], [IGNORE], and [STOP].

Woody is in a room with other users and should only respond when addressed directly, or when the conversation is relevant to trading or market analysis.
If a message is not directly about trading or does not address Woody, respond with [IGNORE].

If a user asks Woody to be quiet, respond with [STOP].
If Woody concludes a conversation and isn't part of the conversation anymore, respond with [STOP].

IMPORTANT: Woody aims to be helpful but not intrusive, so if there is any doubt, it is better to respond with [IGNORE].
If Woody is conversing with a user about trading and they have not asked to stop, it is better to respond with [RESPOND].

The goal is to decide whether Woody should respond to the last message.

{{recentMessages}}

Thread of Tweets You Are Replying To:

{{formattedConversation}}

# INSTRUCTIONS: Choose the option that best describes Woody's response to the last message. Ignore messages if they are addressed to someone else.
` + shouldRespondFooter;


const telegramMessageHandlerTemplate =
  // {{goals}}
  `# Action Examples
{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Knowledge
Woody is proficient in quantitative trading strategies, market trend analysis, and automated risk management.

# Task: Generate dialog and actions for the character Woody.
About Woody:
Woody is an AI-driven quantitative trading robot, adept at optimizing trading performance and executing trades efficiently.
{{lore}}

Examples of Woody's dialog and actions:
{{characterMessageExamples}}

{{providers}}

{{attachments}}

{{actions}}

# Capabilities
Note that Woody can interpret and analyze various forms of media related to trading, including market reports, charts, and financial news. Recent attachments have been included above under the "Attachments" section.

{{messageDirections}}

{{recentMessages}}

# Task: Generate a post/reply in the voice, style, and perspective of Woody (@{{twitterUserName}}) while using the thread of tweets as additional context:
Current Post:
{{currentPost}}
Thread of Tweets You Are Replying To:

{{formattedConversation}}
` + messageCompletionFooter;

export class MessageManager {
  public bot: Bot<Context>;
  private runtime: IAgentRuntime;
  private imageService: IImageDescriptionService;

  constructor(bot: Bot<Context>, runtime: IAgentRuntime) {
    this.bot = bot;
    this.runtime = runtime;
  }

  // Process image messages and generate descriptions
  private async processImage(
    message: Message
  ): Promise<{ description: string } | null> {
    // console.log(
    //     "🖼️ Processing image message:",
    //     JSON.stringify(message, null, 2)
    // );

    try {
      let imageUrl: string | null = null;

      // Handle photo messages
      if ("photo" in message && message.photo!.length > 0) {
        const photo = message.photo![message.photo!.length - 1];
        const fileLink = await this.bot.api.getFile(photo.file_id);
        imageUrl = fileLink.toString();
      }
      // Handle image documents
      else if (
        "document" in message &&
        message.document?.mime_type?.startsWith("image/")
      ) {
        const doc = message.document;
        const fileLink = await this.bot.api.getFile(doc.file_id);
        imageUrl = fileLink.toString();
      }

      if (imageUrl) {
        const { title, description } =
          await this.imageService.describeImage(imageUrl);
        const fullDescription = `[Image: ${title}\n${description}]`;
        return { description: fullDescription };
      }
    } catch (error) {
      console.error("❌ Error processing image:", error);
    }

    return null; // No image found
  }

  // Decide if the bot should respond to the message
  private async _shouldRespond(
    message: Message,
    state: State
  ): Promise<boolean> {
    // Respond if bot is mentioned

    if (
      "text" in message &&
      message.text?.includes(`@${this.bot.botInfo?.username}`)
    ) {
      return true;
    }

    // Respond to private chats
    if (message.chat.type === "private") {
      return true;
    }

    // Respond to images in group chats
    if (
      "photo" in message ||
      ("document" in message &&
        message.document?.mime_type?.startsWith("image/"))
    ) {
      return false;
    }

    // Use AI to decide for text or captions
    if ("text" in message || ("caption" in message && message.caption)) {
      const shouldRespondContext = composeContext({
        state,
        template:
          this.runtime.character.templates?.telegramShouldRespondTemplate ||
          this.runtime.character?.templates?.shouldRespondTemplate ||
          telegramShouldRespondTemplate,
      });

      const response = await generateShouldRespond({
        runtime: this.runtime,
        context: shouldRespondContext,
        modelClass: ModelClass.SMALL,
      });

      return response === "RESPOND";
    }

    return false; // No criteria met
  }

  // Send long messages in chunks
  private async sendMessageInChunks(
    ctx: Context,
    content: string,
    replyToMessageId?: number
  ): Promise<Message.TextMessage[]> {
    const chunks = this.splitMessage(content);
    const sentMessages: Message.TextMessage[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const sentMessage = (await this.bot.api.sendMessage(ctx.chat!.id, chunk, {
        reply_parameters:
          i === 0 && replyToMessageId
            ? { message_id: replyToMessageId }
            : undefined,
      })) as Message.TextMessage;

      sentMessages.push(sentMessage);
    }

    return sentMessages;
  }

  // Split message into smaller parts
  private splitMessage(text: string): string[] {
    const chunks: string[] = [];
    let currentChunk = "";

    const lines = text.split("\n");
    for (const line of lines) {
      if (currentChunk.length + line.length + 1 <= MAX_MESSAGE_LENGTH) {
        currentChunk += (currentChunk ? "\n" : "") + line;
      } else {
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = line;
      }
    }

    if (currentChunk) chunks.push(currentChunk);
    return chunks;
  }

  // Generate a response using AI
  private async _generateResponse(
    message: Memory,
    _state: State,
    context: string
  ): Promise<Content | null> {
    const { userId, roomId } = message;
    console.log("[_generateResponse] check1");
    const response = await generateMessageResponse({
      runtime: this.runtime,
      context,
      modelClass: ModelClass.LARGE,
    });
    console.log("[_generateResponse] check2");
    if (!response) {
      console.error("❌ No response from generateMessageResponse");
      return null;
    }
    console.log("[_generateResponse] check3");
    await this.runtime.databaseAdapter.log({
      body: { message, context, response },
      userId: userId,
      roomId,
      type: "response",
    });
    console.log("[_generateResponse] check4");
    return response;
  }

  // Main handler for incoming messages
  public async handleMessage(ctx: Context): Promise<void> {
    if (!ctx.message || !ctx.from) {
      return; // Exit if no message or sender info
    }

    if (
      this.runtime.character.clientConfig?.telegram?.shouldIgnoreBotMessages &&
      ctx.from.is_bot
    ) {
      return;
    }
    if (
      this.runtime.character.clientConfig?.telegram
        ?.shouldIgnoreDirectMessages &&
      ctx.chat?.type === "private"
    ) {
      return;
    }

    const message = ctx.message;

    try {
      // Convert IDs to UUIDs
      const userId = stringToUuid(ctx.from.id.toString()) as UUID;
      const userName =
        ctx.from.username || ctx.from.first_name || "Unknown User";
      const chatId = stringToUuid(
        ctx.chat?.id.toString() + "-" + this.runtime.agentId
      ) as UUID;
      const agentId = this.runtime.agentId;
      const roomId = chatId;

      await this.runtime.ensureConnection(
        userId,
        roomId,
        userName,
        userName,
        "telegram"
      );

      const messageId = stringToUuid(
        message.message_id.toString() + "-" + this.runtime.agentId
      ) as UUID;

      // Handle images
      const imageInfo = await this.processImage(message);

      // Get text or caption
      let messageText = "";
      if ("text" in message) {
        messageText = ctx.match as string;
      } else if ("caption" in message && message.caption) {
        messageText = message.caption;
      }

      // Combine text and image description
      const fullText = imageInfo
        ? `${messageText} ${imageInfo.description}`
        : messageText;

      if (!fullText) {
        return; // Skip if no content
      }

      const content: Content = {
        text: fullText,
        source: "telegram",
        // inReplyTo:
        //     "reply_to_message" in message && message.reply_to_message
        //         ? stringToUuid(
        //               message.reply_to_message.message_id.toString() +
        //                   "-" +
        //                   this.runtime.agentId
        //           )
        //         : undefined,
      };

      // Create memory for the message
      const memory: Memory = {
        id: messageId,
        agentId,
        userId,
        roomId,
        content,
        createdAt: message.date * 1000,
        embedding: getEmbeddingZeroVector(),
      };

      await this.runtime.messageManager.createMemory(memory);
      // Update state with the new memory
      let state = await this.runtime.composeState(memory);
      state = await this.runtime.updateRecentMessageState(state);
      // Decide whether to respond
      const shouldRespond = await this._shouldRespond(message, state);

      if (shouldRespond) {
        // Generate response
        const context = composeContext({
          state,
          template:
            this.runtime.character.templates?.telegramMessageHandlerTemplate ||
            this.runtime.character?.templates?.messageHandlerTemplate ||
            telegramMessageHandlerTemplate,
        });
        console.log("[handleMessage] context", context);
        const responseContent = await this._generateResponse(
          memory,
          state,
          context
        );

        if (!responseContent || !responseContent.text) return;

        // Send response in chunks
        const callback: HandlerCallback = async (content: Content) => {
          const sentMessages = await this.sendMessageInChunks(
            ctx,
            content.text,
            message.message_id
          );

          const memories: Memory[] = [];

          // Create memories for each sent message
          for (let i = 0; i < sentMessages.length; i++) {
            const sentMessage = sentMessages[i];
            const isLastMessage = i === sentMessages.length - 1;

            const memory: Memory = {
              id: stringToUuid(
                sentMessage.message_id.toString() + "-" + this.runtime.agentId
              ),
              agentId,
              userId,
              roomId,
              content: {
                ...content,
                text: sentMessage.text,
                inReplyTo: messageId,
              },
              createdAt: sentMessage.date * 1000,
              embedding: getEmbeddingZeroVector(),
            };

            // Set action to CONTINUE for all messages except the last one
            // For the last message, use the original action from the response content
            memory.content.action = !isLastMessage ? "IGNORE" : content.action;

            await this.runtime.messageManager.createMemory(memory);
            memories.push(memory);
          }

          return memories;
        };

        // Execute callback to send messages and log memories
        const responseMessages = await callback(responseContent);

        // Update state after response
        state = await this.runtime.updateRecentMessageState(state);

        // Handle any resulting actions
        await this.runtime.processActions(
          memory,
          responseMessages,
          state,
          callback
        );
      }

      await this.runtime.evaluate(memory, state, shouldRespond);
    } catch (error) {
      console.error("❌ Error handling message:", error);
      console.error("Error sending message:", error);
    }
  }
}

export class ElizaService extends BaseService {
  private static instance: ElizaService;
  private runtime: AgentRuntime;
  public messageManager: MessageManager;
  private bot: Bot<Context>;

  private constructor(bot: Bot<Context>) {
    super();

    // Load character from json file
    let character: Character;

    if (!process.env.ELIZA_CHARACTER_PATH) {
      console.log("No ELIZA_CHARACTER_PATH defined, using default character");
      character = defaultCharacter;
    } else {
      try {
        // Use absolute path from project root
        const fullPath = resolve(
          __dirname,
          "../../..",
          process.env.ELIZA_CHARACTER_PATH
        );
        console.log(`Loading character from: ${fullPath}`);

        if (!existsSync(fullPath)) {
          throw new Error(`Character file not found at ${fullPath}`);
        }

        const fileContent = readFileSync(fullPath, "utf-8");
        character = JSON.parse(fileContent);
        console.log("Successfully loaded custom character:", character.name);
      } catch (error) {
        console.error(
          `Failed to load character from ${process.env.ELIZA_CHARACTER_PATH}:`,
          error
        );
        console.log("Falling back to default character");
        character = defaultCharacter;
      }
    }

    // character.modelProvider = ModelProviderName.GAIANET // FIX: Commented out since model provider is best set from character.json

    const sqlitePath = path.join(__dirname, "..", "..", "..", "eliza.sqlite");
    console.log("Using SQLite database at:", sqlitePath);
    // Initialize SQLite adapter
    const db = new SqliteDatabaseAdapter(new Database(sqlitePath));

    db.init()
      .then(() => {
        console.log("Database initialized.");
      })
      .catch((error) => {
        console.error("Failed to initialize database:", error);
        throw error;
      });

    try {
      this.runtime = new AgentRuntime({
        databaseAdapter: db,
        token: process.env.OPENAI_API_KEY || "",
        modelProvider: character.modelProvider || ModelProviderName.GAIANET,
        character,
        conversationLength: 4096,
        plugins: [bootstrapPlugin, collablandPlugin],
        cacheManager: new CacheManager(new MemoryCacheAdapter()),
        logging: true,
      });
      // Create memory manager
      const onChainMemory = new MemoryManager({
        tableName: "onchain",
        runtime: this.runtime,
      });
      this.runtime.registerMemoryManager(onChainMemory);
      this.messageManager = new MessageManager(bot, this.runtime);
      this.bot = bot;
    } catch (error) {
      console.error("Failed to initialize Eliza runtime:", error);
      throw error;
    }
  }

  public static getInstance(bot: Bot<Context>): ElizaService {
    if (!ElizaService.instance) {
      ElizaService.instance = new ElizaService(bot);
    }
    return ElizaService.instance;
  }

  public async start(): Promise<void> {
    try {
      //register AI based command handlers here
      this.bot.command("eliza", (ctx) =>
        this.messageManager.handleMessage(ctx)
      );
      console.log("Eliza service started successfully");
    } catch (error) {
      console.error("Failed to start Eliza service:", error);
      throw error;
    }
  }

  public getRuntime(): AgentRuntime {
    return this.runtime;
  }

  public async stop(): Promise<void> {
    try {
      console.log("Eliza service stopped");
    } catch (error) {
      console.error("Error stopping Eliza service:", error);
    }
  }
}
