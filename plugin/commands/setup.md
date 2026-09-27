---
description: Print the statusLine snippet to paste into your Claude Code settings
allowed-tools: []
---

The hooks are already running — they started the moment this plugin was enabled.
What's missing is the display.

Claude Code plugins cannot ship a `statusLine`; it has to live in the user's own
settings file. So print the snippet and let the user paste it themselves. Do not
edit their settings file for them, and do not offer to.

Print exactly this, with no preamble beyond a single line of context:

---

**Add this to `~/.claude/settings.json`** (or your project's `.claude/settings.json`):

```json
{
  "statusLine": {
    "type": "command",
    "command": "sh -c 'p=$(ls -d \"$HOME\"/.claude/plugins/cache/wishing-willow/willow/*/statusline/willow-status.mjs 2>/dev/null | sort -V | tail -1); if [ -n \"$p\" ]; then exec node \"$p\"; else printf \"\\360\\237\\214\\277 willow · not installed\"; fi'",
    "padding": 1
  }
}
```

If you already have a `statusLine` key, replace it — Claude Code supports only one.

The command finds the installed copy itself rather than naming a version, so
`/plugin update willow` does not silently blank your status line. If the plugin
is gone it prints a short notice instead of nothing: a status line that goes
blank is indistinguishable from one that has nothing to say.

Then start a new session, or run any prompt: the status line updates when the
next assistant message arrives.

**What you'll see**

```
You approved   <your prompt, verbatim>
How I read it  <how the model says it read you>
```

or, when the model didn't declare anything:

```
You approved   <your prompt, verbatim>
⚠ no reading this turn
```

The labels, and the lines Willow asks the model to write, follow the language you
write in: a session in Chinese gets 你批准的 / 我读成了. Set `WILLOW_LANG=en` or
`WILLOW_LANG=zh` to fix one language.

The two rows are never compared for you. Whether they agree is yours to judge —
that is the entire design.

---

After printing, say one sentence: the hooks work without this step, but nothing
is visible until it's done.
