import {
  applyUpdate,
  createInitialState,
  fetchInitial,
  fetchUpdates,
  sendSteer,
  type ClientState,
} from "./session.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function render(state: ClientState, allowSteering: boolean) {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) return;

  app.innerHTML = `
    <main class="layout">
      <header>
        <h1>DeepAgents UI</h1>
        <p>Session: ${escapeHtml(state.sessionId ?? "unknown")}</p>
        <p>Running: ${String(state.running)}</p>
        <p>Active thread: ${escapeHtml(state.activeThreadId ?? "unknown")}</p>
        <p>Updated: ${escapeHtml(state.updatedAt ?? "unknown")}</p>
      </header>
      <section>
        <h2>Threads</h2>
        <ul>${state.threads
          .map(
            (thread) => `<li><strong>${escapeHtml(thread.threadId)}</strong> (${thread.agentKind}, ${thread.status}) ${escapeHtml(thread.latestSummary ?? "")}</li>`,
          )
          .join("")}</ul>
      </section>
      <section>
        <h2>Todos</h2>
        <ul>${state.todos
          .map(
            (todo) => `<li>[${escapeHtml(todo.status)}] ${escapeHtml(todo.content)}</li>`,
          )
          .join("")}</ul>
      </section>
      <section>
        <h2>Files</h2>
        <ul>${state.files
          .map(
            (file) => `<li>${escapeHtml(file.operation)} ${escapeHtml(file.path)}</li>`,
          )
          .join("")}</ul>
      </section>
      <section>
        <h2>Recent Activity</h2>
        <ul>${state.updates
          .slice()
          .reverse()
          .slice(0, 20)
          .map((update) => {
            const detail =
              update.message?.summary ??
              update.message?.content ??
              update.tool?.title ??
              update.tool?.summary ??
              update.event?.summary ??
              update.control?.kind ??
              update.kind;
            return `<li>${escapeHtml(update.kind)}: ${escapeHtml(detail ?? "")}</li>`;
          })
          .join("")}</ul>
      </section>
      <section>
        <h2>Steering</h2>
        ${
          allowSteering
            ? `
          <form id="steer-form">
            <label>
              Kind
              <select name="kind">
                <option value="reminder">reminder</option>
                <option value="message">message</option>
                <option value="add_todo">add_todo</option>
                <option value="set_guidance">set_guidance</option>
              </select>
            </label>
            <label>
              Text
              <input name="text" type="text" placeholder="Before you continue..." />
            </label>
            <button type="submit">Queue command</button>
          </form>
          <p class="hint">Commands are queued and apply at the next safe reasoning boundary.</p>
        `
            : `<p class="hint">Observe-only mode. Steering is disabled for this session.</p>`
        }
      </section>
    </main>
  `;
}

export async function startApp() {
  let state = createInitialState();
  const { initial, config } = await fetchInitial();
  for (const update of initial.updates ?? []) {
    state = applyUpdate(state, update);
  }
  render(state, config.allowSteering);

  document.body.addEventListener("submit", async (event) => {
    const form = event.target as HTMLFormElement | null;
    if (!form || form.id !== "steer-form") return;
    event.preventDefault();

    const formData = new FormData(form);
    await sendSteer({
      kind: String(formData.get("kind") ?? "reminder"),
      text: String(formData.get("text") ?? ""),
    });
    form.reset();
  });

  let cursor = initial.updates?.at(-1)?.event?.id as string | undefined;
  const pollIntervalMs = config.pollIntervalMs ?? 1000;

  setInterval(async () => {
    const page = await fetchUpdates(cursor);
    for (const update of page.updates ?? []) {
      state = applyUpdate(state, update);
    }
    if (page.nextCursor) {
      cursor = page.nextCursor;
    }
    render(state, config.allowSteering);
  }, pollIntervalMs);
}
