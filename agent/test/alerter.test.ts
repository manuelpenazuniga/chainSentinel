import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Alerter,
  TelegramChannel,
  DiscordChannel,
  SlackChannel,
  PagerDutyChannel,
} from "../src/alerter.js";
import { AlertData, AgentConfig, ThreatAssessment } from "../src/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildAssessment(overrides: Partial<ThreatAssessment> = {}): ThreatAssessment {
  return {
    score: 92,
    classification: "CRITICAL_THREAT",
    attackType: "FLASH_LOAN",
    explanation: "Flash loan + drastic balance change in same block",
    recommendedAction: "EMERGENCY_WITHDRAW",
    heuristicScore: 75,
    llmScore: 95,
    llmConfidence: 88,
    llmUsed: true,
    triggeredRules: ["FLASH_LOAN_PATTERN", "DRASTIC_BALANCE_CHANGE"],
    transaction: {
      hash: "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
      from: "0x1111111111111111111111111111111111111111",
      to: "0x2222222222222222222222222222222222222222",
      value: "0",
      input: "0xab9c4b5d",
      gasUsed: "1400000",
      blockNumber: 1234,
      timestamp: 1_700_000_000,
      functionSelector: "0xab9c4b5d",
      decodedFunction: null,
    },
    assessedAt: Date.now(),
    ...overrides,
  };
}

function buildAlert(overrides: Partial<AlertData> = {}): AlertData {
  return {
    type: "THREAT_DETECTED",
    message: "Threat detected with score 92/100",
    timestamp: 1_700_000_000_000,
    assessment: buildAssessment(),
    ...overrides,
  };
}

function buildConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    rpcUrl: "http://localhost",
    chainId: 1,
    agentPrivateKey: "0x" + "0".repeat(64),
    vaultAddress: "0x0000000000000000000000000000000000000001",
    registryAddress: "0x0000000000000000000000000000000000000002",
    geminiApiKey: "dummy",
    heuristicThreshold: 30,
    emergencyThreshold: 80,
    cooldownBlocks: 10,
    llmTimeoutMs: 10_000,
    heartbeatIntervalBlocks: 50,
    persistenceFlushBlocks: 100,
    metricsPort: 0,
    pagerDutyMinScore: 70,
    ...overrides,
  };
}

function mockFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(""),
  } as unknown as Response);
}

// ─── Per-channel tests ──────────────────────────────────────────────────────

describe("TelegramChannel", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("isEnabled returns false when token or chatId missing", () => {
    expect(new TelegramChannel(undefined, undefined).isEnabled()).toBe(false);
    expect(new TelegramChannel("token", undefined).isEnabled()).toBe(false);
    expect(new TelegramChannel(undefined, "chat").isEnabled()).toBe(false);
    expect(new TelegramChannel("token", "chat").isEnabled()).toBe(true);
  });

  it("send is a no-op when disabled", async () => {
    const fetchMock = mockFetch();
    global.fetch = fetchMock;
    await new TelegramChannel().send(buildAlert());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("send POSTs to the Telegram API with chat_id and HTML body", async () => {
    const fetchMock = mockFetch();
    global.fetch = fetchMock;

    await new TelegramChannel("BOT_TOKEN", "-100123").send(buildAlert());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/botBOT_TOKEN/sendMessage");
    expect((init as RequestInit).method).toBe("POST");

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.chat_id).toBe("-100123");
    expect(body.parse_mode).toBe("HTML");
    expect(body.text).toContain("THREAT DETECTED");
    expect(body.text).toContain("FLASH_LOAN");
    expect(body.text).toContain("0xdeadbeef0000");
  });

  it("send throws when the Telegram API returns non-2xx", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    } as unknown as Response);

    await expect(new TelegramChannel("bad", "chat").send(buildAlert())).rejects.toThrow(/Telegram API 401/);
  });
});

describe("DiscordChannel", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("isEnabled tracks the webhook URL presence", () => {
    expect(new DiscordChannel().isEnabled()).toBe(false);
    expect(new DiscordChannel("https://discord.com/api/webhooks/x/y").isEnabled()).toBe(true);
  });

  it("posts a rich embed with score, attack type and triggered rules", async () => {
    const fetchMock = mockFetch();
    global.fetch = fetchMock;

    await new DiscordChannel("https://discord.com/api/webhooks/X").send(buildAlert());

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.embeds).toHaveLength(1);
    const embed = body.embeds[0];
    expect(embed.title).toBe("THREAT DETECTED");
    expect(embed.color).toBe(0xffaa33); // amber for THREAT_DETECTED
    expect(embed.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Score", value: "92/100", inline: true }),
        expect.objectContaining({ name: "Attack", value: "FLASH_LOAN", inline: true }),
        expect.objectContaining({ name: "Rules", value: expect.stringContaining("FLASH_LOAN_PATTERN") }),
      ])
    );
    expect(embed.footer.text).toBe("ChainSentinel");
  });

  it("uses red color for EMERGENCY_EXECUTED", async () => {
    const fetchMock = mockFetch();
    global.fetch = fetchMock;

    await new DiscordChannel("https://discord.com/x").send(
      buildAlert({ type: "EMERGENCY_EXECUTED", message: "Withdrew 1.5 PAS" })
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.embeds[0].color).toBe(0xff4444);
  });
});

describe("SlackChannel", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("isEnabled tracks the webhook URL presence", () => {
    expect(new SlackChannel().isEnabled()).toBe(false);
    expect(new SlackChannel("https://hooks.slack.com/services/X/Y/Z").isEnabled()).toBe(true);
  });

  it("posts a Block Kit payload with header, fields, and rules context", async () => {
    const fetchMock = mockFetch();
    global.fetch = fetchMock;

    await new SlackChannel("https://hooks.slack.com/X").send(buildAlert());

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.text).toContain("THREAT_DETECTED");

    const blocks = body.blocks as Array<{ type: string; text?: { text?: string }; elements?: Array<{ text?: string }> }>;
    expect(blocks[0].type).toBe("header");
    expect((blocks[0] as { text: { text: string } }).text.text).toContain("⚠️");
    // Find the rules context block
    const hasRulesContext = blocks.some(
      (b) => b.type === "context" && b.elements?.some((el) => el.text?.includes("FLASH_LOAN_PATTERN"))
    );
    expect(hasRulesContext).toBe(true);
  });
});

describe("PagerDutyChannel", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("isEnabled tracks the routing key presence", () => {
    expect(new PagerDutyChannel().isEnabled()).toBe(false);
    expect(new PagerDutyChannel("R1").isEnabled()).toBe(true);
  });

  it("does NOT page on low-score THREAT_DETECTED (silent drop)", async () => {
    const fetchMock = mockFetch();
    global.fetch = fetchMock;

    const ch = new PagerDutyChannel("R1", 70);
    await ch.send(buildAlert({ assessment: buildAssessment({ score: 60 }) }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DOES page on high-score THREAT_DETECTED", async () => {
    const fetchMock = mockFetch();
    global.fetch = fetchMock;

    const ch = new PagerDutyChannel("R1", 70);
    await ch.send(buildAlert({ assessment: buildAssessment({ score: 90 }) }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("DOES page on EMERGENCY_EXECUTED regardless of score", async () => {
    const fetchMock = mockFetch();
    global.fetch = fetchMock;

    const ch = new PagerDutyChannel("R1", 99);
    await ch.send(buildAlert({ type: "EMERGENCY_EXECUTED", assessment: buildAssessment({ score: 50 }) }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.routing_key).toBe("R1");
    expect(body.event_action).toBe("trigger");
    expect(body.payload.severity).toBe("critical");
    expect(body.payload.source).toBe("chainsentinel-agent");
    // dedup_key derived from tx hash → keeps repeats from spamming
    expect(body.dedup_key).toContain("0xdeadbeef");
  });

  it("does NOT page on AGENT_STARTED / AGENT_STOPPED", async () => {
    const fetchMock = mockFetch();
    global.fetch = fetchMock;

    const ch = new PagerDutyChannel("R1");
    await ch.send(buildAlert({ type: "AGENT_STARTED", assessment: undefined }));
    await ch.send(buildAlert({ type: "AGENT_STOPPED", assessment: undefined }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("severity is 'critical' for score >= 85, 'warning' otherwise", async () => {
    const fetchMock = mockFetch();
    global.fetch = fetchMock;

    const ch = new PagerDutyChannel("R1", 70);

    await ch.send(buildAlert({ assessment: buildAssessment({ score: 85 }) }));
    let body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.payload.severity).toBe("critical");

    fetchMock.mockClear();
    await ch.send(buildAlert({ assessment: buildAssessment({ score: 75 }) }));
    body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.payload.severity).toBe("warning");
  });
});

// ─── Alerter orchestrator ───────────────────────────────────────────────────

describe("Alerter (multi-channel orchestrator)", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("with no extra channels configured, only console is enabled", () => {
    const alerter = new Alerter(buildConfig());
    expect(alerter.enabledChannels()).toEqual(["console"]);
    expect(alerter.isTelegramEnabled()).toBe(false);
  });

  it("enables every configured channel", () => {
    const alerter = new Alerter(
      buildConfig({
        telegramBotToken: "t",
        telegramChatId: "c",
        discordWebhookUrl: "https://discord/x",
        slackWebhookUrl: "https://slack/x",
        pagerDutyRoutingKey: "R1",
      })
    );
    expect(alerter.enabledChannels()).toEqual([
      "console",
      "telegram",
      "discord",
      "slack",
      "pagerduty",
    ]);
  });

  it("fans out to all enabled HTTP channels in parallel", async () => {
    const fetchMock = mockFetch();
    global.fetch = fetchMock;

    const alerter = new Alerter(
      buildConfig({
        telegramBotToken: "t",
        telegramChatId: "c",
        discordWebhookUrl: "https://discord/x",
        slackWebhookUrl: "https://slack/x",
        pagerDutyRoutingKey: "R1",
      })
    );

    await alerter.sendAlert(buildAlert({ assessment: buildAssessment({ score: 92 }) }));

    // 4 HTTP calls: telegram, discord, slack, pagerduty (console is logger.info)
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const urls = fetchMock.mock.calls.map((call) => call[0]);
    expect(urls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("api.telegram.org"),
        "https://discord/x",
        "https://slack/x",
        "https://events.pagerduty.com/v2/enqueue",
      ])
    );
  });

  it("a failing channel does NOT prevent others from delivering", async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      // Fail Discord, succeed others
      if (url.includes("discord")) {
        return {
          ok: false,
          status: 500,
          text: () => Promise.resolve("internal error"),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      } as unknown as Response;
    });

    const alerter = new Alerter(
      buildConfig({
        telegramBotToken: "t",
        telegramChatId: "c",
        discordWebhookUrl: "https://discord/x",
        slackWebhookUrl: "https://slack/x",
      })
    );

    // Should NOT throw — failures are logged, not propagated.
    await expect(alerter.sendAlert(buildAlert())).resolves.toBeUndefined();
    expect(callCount).toBe(3);
  });

  it("low-score threats reach Discord/Slack but get silently dropped by PagerDuty", async () => {
    const fetchMock = mockFetch();
    global.fetch = fetchMock;

    const alerter = new Alerter(
      buildConfig({
        discordWebhookUrl: "https://discord/x",
        slackWebhookUrl: "https://slack/x",
        pagerDutyRoutingKey: "R1",
        pagerDutyMinScore: 80,
      })
    );

    await alerter.sendAlert(buildAlert({ assessment: buildAssessment({ score: 50 }) }));

    // Only Discord + Slack should hit the network. PagerDuty silently drops.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).not.toContain("https://events.pagerduty.com/v2/enqueue");
  });
});
