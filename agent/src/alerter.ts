// ============================================================================
// ChainSentinel — Multi-Channel Alerter (§6.3)
// ============================================================================
//
// The Alerter fans out each AlertData to every CONFIGURED channel in
// parallel using `Promise.allSettled` so:
//   - A slow channel never blocks the others.
//   - A failing channel never tumbles the rest.
//   - A failing channel is logged but never bubbled — alerts are best-effort
//     side-channel notifications, never on the critical detection path.
//
// Channels currently supported (each opt-in via env vars):
//   - Console        (always on)        → logger.info / .warn
//   - Telegram       TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//   - Discord        DISCORD_WEBHOOK_URL
//   - Slack          SLACK_WEBHOOK_URL
//   - PagerDuty      PAGERDUTY_ROUTING_KEY  (only pages on score ≥ PAGERDUTY_MIN_SCORE)
//
// Adding another channel = implementing the AlertChannel interface and
// instantiating it in the Alerter constructor. The Alerter itself stays
// untouched.
// ============================================================================

import { AlertData, AgentConfig } from "./types.js";
import { createLogger } from "./logger.js";

const logger = createLogger("alerter");

// ─── Channel Interface ──────────────────────────────────────────────────────

export interface AlertChannel {
  /** Stable name for logs / telemetry / error messages. */
  readonly name: string;
  /** Returns true if the channel is fully configured and should attempt sends. */
  isEnabled(): boolean;
  /** Send a single alert. Throws on transport failure. */
  send(alert: AlertData): Promise<void>;
}

// ─── Console (always on) ────────────────────────────────────────────────────

class ConsoleChannel implements AlertChannel {
  readonly name = "console";
  isEnabled(): boolean {
    return true;
  }
  async send(alert: AlertData): Promise<void> {
    const lvl = alert.type === "EMERGENCY_EXECUTED" || alert.type === "AGENT_ERROR" ? "warn" : "info";
    logger[lvl](`ALERT [${alert.type}]: ${alert.message}`);
  }
}

// ─── Telegram ──────────────────────────────────────────────────────────────

export class TelegramChannel implements AlertChannel {
  readonly name = "telegram";
  constructor(private readonly token?: string, private readonly chatId?: string) {}

  isEnabled(): boolean {
    return !!(this.token && this.chatId);
  }

  async send(alert: AlertData): Promise<void> {
    if (!this.isEnabled()) return;
    const text = this.format(alert);
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      throw new Error(`Telegram API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }

  private format(alert: AlertData): string {
    const headers: Record<AlertData["type"], string> = {
      EMERGENCY_EXECUTED: "🚨 <b>EMERGENCY WITHDRAWAL EXECUTED</b>",
      THREAT_DETECTED: "⚠️ <b>THREAT DETECTED</b>",
      AGENT_ERROR: "❌ <b>AGENT ERROR</b>",
      AGENT_STARTED: "✅ <b>ChainSentinel Agent Started</b>",
      AGENT_STOPPED: "⏹ <b>ChainSentinel Agent Stopped</b>",
    };
    const lines = [headers[alert.type] ?? `ℹ️ ${alert.type}`, "", alert.message];

    if (alert.assessment) {
      const a = alert.assessment;
      lines.push(
        "",
        `<b>Score:</b> ${a.score}/100`,
        `<b>Type:</b> ${a.attackType}`,
        `<b>Classification:</b> ${a.classification}`,
        `<b>Action:</b> ${a.recommendedAction}`,
        "",
        `<b>Tx:</b> <code>${a.transaction.hash}</code>`,
        `<b>From:</b> <code>${a.transaction.from}</code>`,
        `<b>To:</b> <code>${a.transaction.to}</code>`,
      );
      if (a.triggeredRules.length > 0) {
        lines.push("", `<b>Triggered rules:</b> ${a.triggeredRules.join(", ")}`);
      }
      if (a.explanation) lines.push("", `<b>Analysis:</b> ${a.explanation}`);
    }
    lines.push("", `<i>${new Date(alert.timestamp).toISOString()}</i>`);
    return lines.join("\n");
  }
}

// ─── Discord (incoming webhook) ────────────────────────────────────────────

export class DiscordChannel implements AlertChannel {
  readonly name = "discord";
  constructor(private readonly webhookUrl?: string) {}

  isEnabled(): boolean {
    return !!this.webhookUrl;
  }

  async send(alert: AlertData): Promise<void> {
    if (!this.isEnabled()) return;
    const payload = this.buildPayload(alert);
    const res = await fetch(this.webhookUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Discord webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }

  /**
   * Discord rich embed. Color is encoded as decimal int (e.g. 0xff4444 → 16729156).
   *   - red    = EMERGENCY / ERROR
   *   - amber  = THREAT
   *   - green  = STARTED
   *   - gray   = STOPPED / other
   */
  private buildPayload(alert: AlertData): Record<string, unknown> {
    const color =
      alert.type === "EMERGENCY_EXECUTED" || alert.type === "AGENT_ERROR"
        ? 0xff4444
        : alert.type === "THREAT_DETECTED"
        ? 0xffaa33
        : alert.type === "AGENT_STARTED"
        ? 0x33dd66
        : 0x888888;

    const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
    if (alert.assessment) {
      const a = alert.assessment;
      fields.push(
        { name: "Score", value: `${a.score}/100`, inline: true },
        { name: "Attack", value: a.attackType, inline: true },
        { name: "Action", value: a.recommendedAction, inline: true },
        { name: "Tx", value: `\`${a.transaction.hash}\`` },
        { name: "Target", value: `\`${a.transaction.to}\``, inline: true },
        { name: "Sender", value: `\`${a.transaction.from}\``, inline: true },
      );
      if (a.triggeredRules.length > 0) {
        fields.push({ name: "Rules", value: a.triggeredRules.join(", ") });
      }
      if (a.explanation) {
        fields.push({ name: "Analysis", value: a.explanation.slice(0, 1000) });
      }
    }

    return {
      embeds: [
        {
          title: alert.type.replace(/_/g, " "),
          description: alert.message,
          color,
          fields,
          timestamp: new Date(alert.timestamp).toISOString(),
          footer: { text: "ChainSentinel" },
        },
      ],
    };
  }
}

// ─── Slack (incoming webhook) ──────────────────────────────────────────────

export class SlackChannel implements AlertChannel {
  readonly name = "slack";
  constructor(private readonly webhookUrl?: string) {}

  isEnabled(): boolean {
    return !!this.webhookUrl;
  }

  async send(alert: AlertData): Promise<void> {
    if (!this.isEnabled()) return;
    const payload = this.buildPayload(alert);
    const res = await fetch(this.webhookUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Slack webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }

  /**
   * Slack Block Kit payload. Uses a minimal subset (header + section + context)
   * so the message renders cleanly in any Slack workspace.
   */
  private buildPayload(alert: AlertData): Record<string, unknown> {
    const emoji =
      alert.type === "EMERGENCY_EXECUTED"
        ? "🚨"
        : alert.type === "THREAT_DETECTED"
        ? "⚠️"
        : alert.type === "AGENT_ERROR"
        ? "❌"
        : alert.type === "AGENT_STARTED"
        ? "✅"
        : "ℹ️";

    const blocks: Array<Record<string, unknown>> = [
      {
        type: "header",
        text: { type: "plain_text", text: `${emoji} ${alert.type.replace(/_/g, " ")}` },
      },
      { type: "section", text: { type: "mrkdwn", text: alert.message } },
    ];

    if (alert.assessment) {
      const a = alert.assessment;
      blocks.push({
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Score:* ${a.score}/100` },
          { type: "mrkdwn", text: `*Attack:* ${a.attackType}` },
          { type: "mrkdwn", text: `*Action:* ${a.recommendedAction}` },
          { type: "mrkdwn", text: `*Class:* ${a.classification}` },
          { type: "mrkdwn", text: `*Tx:* \`${a.transaction.hash.slice(0, 10)}…\`` },
          { type: "mrkdwn", text: `*Target:* \`${a.transaction.to.slice(0, 10)}…\`` },
        ],
      });
      if (a.triggeredRules.length > 0) {
        blocks.push({
          type: "context",
          elements: [
            { type: "mrkdwn", text: `*Rules:* ${a.triggeredRules.join(", ")}` },
          ],
        });
      }
      if (a.explanation) {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: `_${a.explanation.slice(0, 1500)}_` },
        });
      }
    }

    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<!date^${Math.floor(alert.timestamp / 1000)}^{date_short_pretty} {time}|${new Date(alert.timestamp).toISOString()}>`,
        },
      ],
    });

    return { text: `${emoji} ${alert.type}: ${alert.message}`, blocks };
  }
}

// ─── PagerDuty (Events API v2) ─────────────────────────────────────────────

export class PagerDutyChannel implements AlertChannel {
  readonly name = "pagerduty";
  /**
   * @param routingKey  PagerDuty Events API v2 routing key (integration key).
   * @param minScore    Minimum threat score to page on. Below this, the
   *                    channel silently drops the alert (it should not page
   *                    oncall for low-risk MONITOR-tier events).
   */
  constructor(
    private readonly routingKey?: string,
    private readonly minScore: number = 70
  ) {}

  isEnabled(): boolean {
    return !!this.routingKey;
  }

  /**
   * Decide which alert types are page-worthy. Only safety-critical signals
   * reach oncall; lifecycle events (started/stopped/low-score threats) skip
   * PagerDuty entirely.
   */
  private shouldPage(alert: AlertData): boolean {
    if (alert.type === "EMERGENCY_EXECUTED" || alert.type === "AGENT_ERROR") return true;
    if (alert.type === "THREAT_DETECTED" && alert.assessment) {
      return alert.assessment.score >= this.minScore;
    }
    return false;
  }

  async send(alert: AlertData): Promise<void> {
    if (!this.isEnabled()) return;
    if (!this.shouldPage(alert)) return; // silently drop — not page-worthy

    const severity =
      alert.type === "EMERGENCY_EXECUTED"
        ? "critical"
        : alert.type === "AGENT_ERROR"
        ? "error"
        : alert.assessment && alert.assessment.score >= 85
        ? "critical"
        : "warning";

    const dedupKey = alert.assessment?.transaction.hash
      ? `chainsentinel:${alert.type}:${alert.assessment.transaction.hash}`
      : `chainsentinel:${alert.type}:${alert.timestamp}`;

    const payload = {
      routing_key: this.routingKey,
      event_action: "trigger",
      dedup_key: dedupKey,
      payload: {
        summary: `[ChainSentinel] ${alert.type}: ${alert.message}`.slice(0, 1024),
        source: "chainsentinel-agent",
        severity,
        component: alert.assessment?.transaction.to ?? "unknown",
        group: "defi-security",
        class: alert.assessment?.attackType ?? alert.type,
        custom_details: alert.assessment
          ? {
              score: alert.assessment.score,
              classification: alert.assessment.classification,
              attack_type: alert.assessment.attackType,
              triggered_rules: alert.assessment.triggeredRules,
              tx_hash: alert.assessment.transaction.hash,
              tx_from: alert.assessment.transaction.from,
              tx_to: alert.assessment.transaction.to,
              llm_used: alert.assessment.llmUsed,
              llm_confidence: alert.assessment.llmConfidence,
              explanation: alert.assessment.explanation,
            }
          : { type: alert.type, timestamp: alert.timestamp },
      },
    };

    const res = await fetch("https://events.pagerduty.com/v2/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`PagerDuty Events API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }
}

// ─── Alerter (orchestrator) ─────────────────────────────────────────────────

/**
 * Multi-channel alert dispatcher. Constructs all channels declared in `config`
 * and sends each AlertData to every ENABLED channel in parallel. A failing
 * channel is logged but never breaks the others — alert delivery is
 * best-effort and must not impact threat detection latency.
 */
export class Alerter {
  private channels: AlertChannel[];

  constructor(config: AgentConfig) {
    this.channels = [
      new ConsoleChannel(),
      new TelegramChannel(config.telegramBotToken, config.telegramChatId),
      new DiscordChannel(config.discordWebhookUrl),
      new SlackChannel(config.slackWebhookUrl),
      new PagerDutyChannel(config.pagerDutyRoutingKey, config.pagerDutyMinScore),
    ];

    const enabled = this.channels.filter((c) => c.isEnabled()).map((c) => c.name);
    logger.info(`Alerter initialised with ${enabled.length} channels: ${enabled.join(", ")}`);
  }

  /** Returns the set of channel names that are currently enabled. */
  enabledChannels(): string[] {
    return this.channels.filter((c) => c.isEnabled()).map((c) => c.name);
  }

  /** Backwards-compat shortcut used by older callers. */
  isTelegramEnabled(): boolean {
    return this.channels.some((c) => c.name === "telegram" && c.isEnabled());
  }

  async sendAlert(alert: AlertData): Promise<void> {
    const enabled = this.channels.filter((c) => c.isEnabled());
    if (enabled.length === 0) return;

    const results = await Promise.allSettled(
      enabled.map(async (channel) => {
        try {
          await channel.send(alert);
        } catch (error) {
          // Wrap with channel name for diagnostics
          throw new Error(`[${channel.name}] ${(error as Error).message}`);
        }
      })
    );

    for (const r of results) {
      if (r.status === "rejected") {
        logger.warn(`Alert delivery failed: ${(r.reason as Error).message}`);
      }
    }
  }

  /** Send a simple status message (not tied to a threat assessment). */
  async sendStatusUpdate(message: string): Promise<void> {
    await this.sendAlert({
      type: "AGENT_STARTED",
      message,
      timestamp: Date.now(),
    });
  }
}
