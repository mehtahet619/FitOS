import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Behavioural tests for the exercise demonstration player lifecycle in
 * frontend/app.js.
 *
 * app.js is a browser script, so the demonstration functions are evaluated
 * against a tiny stubbed DOM/timer environment. This exercises the real
 * ready / error / timeout paths without adding a full DOM dependency.
 */

const APP_SOURCE = fs.readFileSync(path.resolve(__dirname, "../../../frontend/app.js"), "utf8");

type PlayerBehavior = "ready" | "error" | "silent";

interface FakeNode {
  tagName: string;
  className: string;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  src: string;
  async: boolean;
  dataset: Record<string, string>;
  children: FakeNode[];
  listeners: Record<string, Array<(event?: unknown) => void>>;
  append(...nodes: FakeNode[]): void;
  replaceChildren(...nodes: FakeNode[]): void;
  addEventListener(type: string, handler: (event?: unknown) => void): void;
}

class Element implements FakeNode {
  tagName: string;
  className = "";
  textContent = "";
  hidden = false;
  disabled = false;
  src = "";
  async = false;
  dataset: Record<string, string> = {};
  children: FakeNode[] = [];
  listeners: Record<string, Array<(event?: unknown) => void>> = {};

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeNode[]): void {
    this.children = nodes;
    this.textContent = "";
  }

  addEventListener(type: string, handler: (event?: unknown) => void): void {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }
}

interface DemoModule {
  loadYouTubeIframeApi: () => Promise<unknown>;
  startExerciseDemoPlayer: (player: FakeNode, button: FakeNode, exercise: unknown) => Promise<void>;
  fallbackExerciseDemoPlayback: (player: FakeNode, button: FakeNode, exercise: unknown, demo: unknown) => Promise<void>;
}

function loadDemoModule(windowStub: unknown, documentStub: unknown, apiStub: unknown): DemoModule {
  const start = APP_SOURCE.indexOf("let youtubeIframeApiPromise = null;");
  const end = APP_SOURCE.indexOf("function renderWorkout(workout, plan) {");
  if (start < 0 || end <= start) {
    throw new Error("Could not locate the demonstration player functions in frontend/app.js");
  }
  const body = `${APP_SOURCE.slice(start, end)}
return { loadYouTubeIframeApi: loadYouTubeIframeApi, startExerciseDemoPlayer: startExerciseDemoPlayer, fallbackExerciseDemoPlayback: fallbackExerciseDemoPlayback };`;
  const factory = new Function("window", "document", "Api", body) as unknown as (
    window: unknown, document: unknown, api: unknown,
  ) => DemoModule;
  return factory(windowStub, documentStub, apiStub);
}

interface Harness {
  module: DemoModule;
  player: FakeNode;
  button: FakeNode;
  head: FakeNode;
  createdPlayers: Array<{ options: Record<string, any> }>;
  apiPaths: string[];
  runTimers: () => void;
  pendingTimers: () => number;
}

interface HarnessOptions {
  yt?: boolean;
  playerBehaviors?: PlayerBehavior[];
  refreshDemo?: unknown;
}

function bootstrap(options: HarnessOptions = {}): Harness {
  const timers = new Map<number, () => void>();
  const createdPlayers: Array<{ options: Record<string, any> }> = [];
  const apiPaths: string[] = [];
  let nextTimerId = 0;

  const windowStub: Record<string, any> = {
    setTimeout: (fn: () => void) => {
      nextTimerId += 1;
      timers.set(nextTimerId, fn);
      return nextTimerId;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
  };

  if (options.yt !== false) {
    const behaviors = options.playerBehaviors ?? ["silent"];
    windowStub.YT = {
      Player: function Player(_host: FakeNode, playerOptions: Record<string, any>) {
        const behavior = behaviors[createdPlayers.length] ?? "silent";
        createdPlayers.push({ options: playerOptions });
        if (behavior === "ready") playerOptions.events.onReady();
        if (behavior === "error") playerOptions.events.onError();
      },
    };
  }

  const head = new Element("head");
  const documentStub = {
    head,
    createElement: (tagName: string) => new Element(tagName),
    querySelector: (selector: string) =>
      selector.includes("data-youtube-iframe-api")
        ? head.children.find((node) => node.tagName === "script") ?? null
        : null,
  };

  const apiStub = {
    get: async (requestPath: string) => {
      apiPaths.push(requestPath);
      return { demoVideo: options.refreshDemo ?? null };
    },
  };

  return {
    module: loadDemoModule(windowStub, documentStub, apiStub),
    player: new Element("div"),
    button: new Element("button"),
    head,
    createdPlayers,
    apiPaths,
    runTimers: () => {
      const queued = Array.from(timers.values());
      timers.clear();
      queued.forEach((fn) => fn());
    },
    pendingTimers: () => timers.size,
  };
}

function exercise() {
  return {
    exerciseId: "ex-1",
    exerciseName: "Bent Over Row",
    equipmentRequired: ["Barbell"],
    movementPattern: "horizontal_pull",
    demoVideo: { kind: "video", videoId: "iKrKgWR9wbY", thumbnailUrl: "https://example.test/thumb.jpg" },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function showsUnavailableGuide(player: FakeNode): boolean {
  return player.children.some((child) => child.className.includes("exercise-demo-unavailable"));
}

describe("exercise demonstration playback lifecycle", () => {
  it("keeps the exercise-specific video playing and clears the loading state on ready", async () => {
    const harness = bootstrap({ playerBehaviors: ["ready"] });
    await harness.module.startExerciseDemoPlayer(harness.player, harness.button, exercise());

    expect(harness.createdPlayers).toHaveLength(1);
    expect(harness.createdPlayers[0].options.videoId).toBe("iKrKgWR9wbY");
    expect(harness.createdPlayers[0].options.playerVars.autoplay).toBe(0);
    expect(harness.player.dataset.loading).toBeUndefined();
    expect(harness.button.disabled).toBe(false);
    expect(harness.button.hidden).toBe(true);
    expect(showsUnavailableGuide(harness.player)).toBe(false);
    expect(harness.apiPaths).toHaveLength(0);
  });

  it("falls back to the written guide when the video reports an error, refreshing only once", async () => {
    const harness = bootstrap({ playerBehaviors: ["error"] });
    await harness.module.startExerciseDemoPlayer(harness.player, harness.button, exercise());
    await flush();

    expect(harness.apiPaths).toHaveLength(1);
    expect(harness.apiPaths[0]).toContain("/exercises/ex-1/demo-video");
    expect(harness.apiPaths[0]).toContain("refresh=1");
    expect(harness.apiPaths[0]).toContain("exclude=iKrKgWR9wbY");
    expect(harness.player.dataset.loading).toBeUndefined();
    expect(showsUnavailableGuide(harness.player)).toBe(true);
    expect(harness.button.disabled).toBe(false);
    expect(harness.button.hidden).toBe(false);
  });

  it("stops loading and falls back when the player never becomes ready", async () => {
    const harness = bootstrap({ playerBehaviors: ["silent"] });
    const started = harness.module.startExerciseDemoPlayer(harness.player, harness.button, exercise());
    await flush();

    expect(harness.player.dataset.loading).toBe("true");
    expect(harness.button.disabled).toBe(true);
    expect(harness.pendingTimers()).toBe(1);

    harness.runTimers();
    await started;
    await flush();

    expect(harness.player.dataset.loading).toBeUndefined();
    expect(harness.apiPaths).toHaveLength(1);
    expect(showsUnavailableGuide(harness.player)).toBe(true);
  });

  it("ignores a late ready or error after the init timeout already fell back", async () => {
    const harness = bootstrap({ playerBehaviors: ["silent"] });
    const started = harness.module.startExerciseDemoPlayer(harness.player, harness.button, exercise());
    await flush();
    harness.runTimers();
    await started;
    await flush();

    const refreshesAfterTimeout = harness.apiPaths.length;
    expect(refreshesAfterTimeout).toBe(1);

    harness.createdPlayers[0].options.events.onError();
    harness.createdPlayers[0].options.events.onReady();
    await flush();

    expect(harness.apiPaths).toHaveLength(1);
    expect(harness.player.dataset.loading).toBeUndefined();
    expect(showsUnavailableGuide(harness.player)).toBe(true);
  });

  it("resolves and falls back when the YouTube API script is blocked", async () => {
    const harness = bootstrap({ yt: false });
    const started = harness.module.startExerciseDemoPlayer(harness.player, harness.button, exercise());

    const script = harness.head.children.find((node) => node.tagName === "script");
    expect(script).toBeDefined();
    script!.listeners.error[0]();

    await started;
    await flush();

    expect(harness.createdPlayers).toHaveLength(0);
    expect(harness.player.dataset.loading).toBeUndefined();
    expect(showsUnavailableGuide(harness.player)).toBe(true);
  });

  it("resolves and falls back when the YouTube API never loads", async () => {
    const harness = bootstrap({ yt: false });
    const started = harness.module.startExerciseDemoPlayer(harness.player, harness.button, exercise());
    await flush();

    expect(harness.player.dataset.loading).toBe("true");
    expect(harness.pendingTimers()).toBe(1);

    harness.runTimers();
    await started;
    await flush();

    expect(harness.createdPlayers).toHaveLength(0);
    expect(harness.player.dataset.loading).toBeUndefined();
    expect(showsUnavailableGuide(harness.player)).toBe(true);
  });

  it("restarts with the refreshed exercise video instead of a different exercise", async () => {
    const refreshedDemo = { kind: "video", videoId: "refreshed99", thumbnailUrl: "https://example.test/2.jpg" };
    const harness = bootstrap({ playerBehaviors: ["error", "ready"], refreshDemo: refreshedDemo });
    const target = exercise();

    await harness.module.startExerciseDemoPlayer(harness.player, harness.button, target);
    await flush();
    await flush();

    expect(harness.createdPlayers).toHaveLength(2);
    expect(harness.createdPlayers[1].options.videoId).toBe("refreshed99");
    expect((target.demoVideo as { videoId: string }).videoId).toBe("refreshed99");
    expect(harness.player.dataset.loading).toBeUndefined();
    expect(harness.button.hidden).toBe(true);
    expect(showsUnavailableGuide(harness.player)).toBe(false);
  });
});
