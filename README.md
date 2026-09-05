# @rabi/dsh-tui

The `dsh` terminal-surface bundle: a pi-style interactive TUI over the `dsh-base` layer. One process, one agent, one session — the transcript flows into terminal scrollback while the live tail (streaming assistant text, input editor, status line) is differential-rendered at the bottom of the viewport.

## Usage

```sh
dsh --profile tui                    # fresh session
dsh --profile tui --resume <id>      # continue a persisted session
dsh --profile tui --session <id>     # fresh session with an exact id
```

Keys:

| Key | Action |
| --- | --- |
| `Enter` | send the prompt; queues a follow-up turn while one is running |
| `Shift+Enter` | newline in the editor |
| `Tab` | complete slash commands and file paths |
| `Escape` | cancel the active turn (like `Ctrl+C` while running) |
| `Ctrl+C` | cancel the active turn; quit when idle |
| `Alt+Up` | pull queued follow-ups back into the editor |
| `Ctrl+O` | toggle full tool output (arguments and results) |
| `Ctrl+X` | copy the last assistant message to the system clipboard |
| `Ctrl+D` | quit |
| `/exit`, `/quit` | quit |
| `/help` | show the command and key reference |
| `/clear` | clear the transcript |

Prompts sent while a turn is running queue as follow-up turns and render as dim `⏳` lines above the editor. Cancelling the turn (or `Alt+Up`) pulls the queued texts back into the editor for re-editing.

Typing `/` at the start of a message offers slash-command completion — the TUI's own shortcuts, commands registered by the profile, and user-invocable skills — with `Tab` completing the highlighted entry; file paths complete from the working directory. The roster tracks registry changes live, so commands added or removed at runtime appear in the dropdown without a restart.

Tool approvals (the base profile's default `ask` policy) are answered in-terminal with a `y`/`n` prompt; cancelling the turn cancels the pending request.

`Ctrl+X` copies the last assistant message to the system clipboard using the OSC 52 escape sequence, so it works over SSH where no local clipboard is otherwise reachable; terminals without OSC 52 support simply ignore the sequence.

Background activity that would otherwise be silent gets a transcript note: an automatic mid-turn compaction shows `⋯ compacting conversation…` and settles to `✓ compacted conversation` (or a red failure line), and each scheduled model retry logs one dim line such as `↻ retrying model call 1/3 in ~2s — 429 Too Many Requests`. Manual `/compact` reports through its own command result instead, and the notes replay on resume because they derive from durable session events.

While a turn is running — including long tool calls — a braille spinner animates in the status line so the surface never looks frozen. The status line also shows context consumption (`used/window ctx`, e.g. `12.3k/164k ctx`) from the last model call's usage against the adapter-reported context window; without a reported window it shows used tokens alone. Once the session has spent tokens, a cumulative total follows (`Σ 45.2k`) — every model call's usage added up, distinct from the current context fill. Its key hints follow the state: idle shows the input shortcuts (`⏎ send · tab complete · ^o tools · ^x copy · ^c/^d quit`), running shows `esc/^c cancel` plus `alt+↑ dequeue` while follow-ups are queued.

## Install into a profile

The bundle is a patch layer over `@deepseek-ai/dsh-base`. A profile depends on this package and lists both bundles:

```json
{
  "dependencies": {
    "@rabi/dsh-tui": "github:rabi/dsh-tui"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@rabi/dsh-tui"]
    }
  }
}
```

then `pnpm install` in the profile directory. For local development use a `link:` specifier to this checkout instead of the GitHub URL. The `@deepseek-ai/*` peer dependencies are provided by the running `dsh` installation; the profile sets `autoInstallPeers: false`.

Model selection comes from the profile's usual `agentDefaultModel` configuration (provider/model settings or environment), the same as every other surface.

## Development

Type checking and tests run against a sibling `deepseek-harness` checkout (`../deepseek-harness`): `tsc -b` references its workspace projects, and `postinstall` links its built `@deepseek-ai/*` packages into `node_modules` so tests load the same module instances production does.

```sh
pnpm install        # dev deps + peer links + prepare build
pnpm run build      # tsc -b (types + JS) && tsdown (bundled lib/)
pnpm test           # vitest against the sibling checkout's built packages
pnpm run lint       # oxlint (type-aware, harness rule parity)
```

Rebuild the harness after changing it there; the tests consume its `lib/` output.

## Layout

- `src/startup.ts` — the `tui-startup` plugin: parses `--session`/`--resume`/`--help` and publishes the `tuiStartup` service.
- `src/index.ts` — the `tui-runner` plugin: creates or resumes one Agent through the core registry, replays the committed log into the transcript, streams live session events, answers approval requests, and exits through the launcher's bounded exit request.
- `src/tui.ts` — pure presentation: transcript items, streaming drafts, status line, and the serialized approval gate, composed on `@earendil-works/pi-tui`'s main-screen TUI.
- `cordis.patch.yml` — the bundle patch layer (persona + the two plugin rows).

No invariant companion is published because the bundle holds no mutable state of its own: every contribution (the two plugin rows, the session-event and approval listeners) is registry-disposed with the fiber, and the transcript and status line are pure projections of the session log.

## Limitations

- Single agent per process; no model switching mid-session.
- Resumed sessions replay the full committed log (including pre-compaction history) into the transcript.
- Fixed ANSI palette; no theme configuration.
