import { AlertData, AgentConfig } from "./types.js";
import { createLogger } from "./logger.js";

const logger = createLogger("alerter");

/**
 * Multi-channel alert system for ChainSentinel.
 *
 * Currently supports:
 * - Console logging (always active)
 * - Telegram Bot API (requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)
 *
 * Setup Telegram:
 * 1. Message @BotFather on Telegram → /newbot → follow prompts
 * 2. Copy the bot token (looks like: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz)
 * 3. Add the bot to a group or start a DM with it
 * 4. Get chat ID: visit https://api.telegram.org/bot<TOKEN>/getUpdates
 *    after sending a message — the chat.id field is your TELEGRAM_CHAT_ID
 * 5. Set both in .env:
 *    TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
 *    TELEGRAM_CHAT_ID=-100123456789  (groups are negative, DMs are positive)
 */
export class Alerter {
  private config: AgentConfig;
  private telegramEnabled: boolean;

  constructor(config: AgentConfig) {
    this.config = config;
    this.telegramEnabled = !!(config.telegramBotToken && config.telegramChatId);

    if (this.telegramEnabled) {
      logger.info("Telegram alerting enabled");
    } else {
      logger.info(
        "Telegram alerting disabled — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env to enable"
      );
    }
  }

  /** Returns true if Telegram notifications are configured */
  isTelegramEnabled(): boolean {
    return this.telegramEnabled;
  }

  async sendAlert(alert: AlertData): Promise<void> {
    // Always log to console
    const logLevel =
      alert.type === "EMERGENCY_EXECUTED" || alert.type === "AGENT_ERROR"
        ? "warn"
        : "info";
    logger[logLevel](`ALERT [${alert.type}]: ${alert.message}`);

    // Send to Telegram if configured
    if (this.telegramEnabled) {
      try {
        const text = this.formatTelegramMessage(alert);
        await this.sendTelegram(text);
        logger.debug("Telegram alert sent successfully");
      } catch (error) {
        logger.warn("Failed to send Telegram alert:", error);
      }
    }
  }

  /** Send a simple status message (not tied to a threat assessment) */
  async sendStatusUpdate(message: string): Promise<void> {
    await this.sendAlert({
      type: "AGENT_STARTED",
      message,
      timestamp: Date.now(),
    });
  }

  private formatTelegramMessage(alert: AlertData): string {
    const headers: Record<AlertData["type"], string> = {
      EMERGENCY_EXECUTED: "🚨 <b>EMERGENCY WITHDRAWAL EXECUTED</b>",
      THREAT_DETECTED: "⚠️ <b>THREAT DETECTED</b>",
      AGENT_ERROR: "❌ <b>AGENT ERROR</b>",
      AGENT_STARTED: "✅ <b>ChainSentinel Agent Started</b>",
      AGENT_STOPPED: "⏹ <b>ChainSentinel Agent Stopped</b>",
    };

    const header = headers[alert.type] || `ℹ️ ${alert.type}`;
    const lines = [header, "", alert.message];

    if (alert.assessment) {
      const a = alert.assessment;
      lines.push("");
      lines.push(`<b>Score:</b> ${a.score}/100`);
      lines.push(`<b>Type:</b> ${a.attackType}`);
      lines.push(`<b>Classification:</b> ${a.classification}`);
      lines.push(`<b>Action:</b> ${a.recommendedAction}`);
      lines.push("");
      lines.push(`<b>Tx:</b> <code>${a.transaction.hash}</code>`);
      lines.push(`<b>From:</b> <code>${a.transaction.from}</code>`);
      lines.push(`<b>To:</b> <code>${a.transaction.to}</code>`);

      if (a.triggeredRules.length > 0) {
        lines.push("");
        lines.push(`<b>Triggered rules:</b> ${a.triggeredRules.join(", ")}`);
      }

      if (a.explanation) {
        lines.push("");
        lines.push(`<b>Analysis:</b> ${a.explanation}`);
      }
    }

    lines.push("");
    lines.push(
      `<i>${new Date(alert.timestamp).toISOString()}</i>`
    );

    return lines.join("\n");
  }

  private async sendTelegram(text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.config.telegramChatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram API error: ${response.status} ${body}`);
    }
  }
}
