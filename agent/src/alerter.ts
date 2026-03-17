import { AlertData, AgentConfig } from "./types.js";
import { createLogger } from "./logger.js";

const logger = createLogger("alerter");

export class Alerter {
  private config: AgentConfig;
  private enabled: boolean;

  constructor(config: AgentConfig) {
    this.config = config;
    this.enabled = !!(config.telegramBotToken && config.telegramChatId);

    if (this.enabled) {
      logger.info("Telegram alerting enabled");
    } else {
      logger.info("Telegram alerting disabled (no bot token or chat ID)");
    }
  }

  async sendAlert(alert: AlertData): Promise<void> {
    logger.info(`ALERT [${alert.type}]: ${alert.message}`);

    if (!this.enabled) return;

    try {
      const text = this.formatTelegramMessage(alert);
      await this.sendTelegram(text);
    } catch (error) {
      logger.warn("Failed to send Telegram alert:", error);
    }
  }

  private formatTelegramMessage(alert: AlertData): string {
    const header = alert.type === "EMERGENCY_EXECUTED"
      ? "🚨 EMERGENCY WITHDRAWAL EXECUTED"
      : alert.type === "THREAT_DETECTED"
      ? "⚠️ THREAT DETECTED"
      : `ℹ️ ${alert.type}`;

    let body = `${header}\n\n${alert.message}`;

    if (alert.assessment) {
      const a = alert.assessment;
      body += `\n\nScore: ${a.score}/100`;
      body += `\nType: ${a.attackType}`;
      body += `\nClassification: ${a.classification}`;
      body += `\nTx: ${a.transaction.hash}`;
      body += `\nTarget: ${a.transaction.to}`;
      if (a.explanation) body += `\n\nExplanation: ${a.explanation}`;
    }

    body += `\n\nTimestamp: ${new Date(alert.timestamp).toISOString()}`;

    return body;
  }

  private async sendTelegram(text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.config.telegramChatId,
        text: text,
        parse_mode: "HTML",
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram API error: ${response.status} ${body}`);
    }
  }
}
