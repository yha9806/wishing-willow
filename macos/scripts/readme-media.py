#!/usr/bin/env python3
"""README 素材（lintel 版）：用插件自己的钩子建几场虚构的会话，许愿柳 app 导出成 lintel 活动，
lintel 宿主画出来，在真屏幕上按窗口外框截图。中英各一套。

    python3 macos/scripts/readme-media.py [场景 …]      场景：compact arrival hover popover list turns（默认全拍）

需要：
  - 许愿柳 app 的 release 构建（macos/.build/release/WishingWillow），`make build` 或 `swift build -c release`；
  - lintel 的 release 构建：环境变量 LINTEL_BIN 指向它，默认 ../lintel/.build/release/lintel（和本仓并排克隆）；
  - node、屏幕录制权限（screencapture）。屏幕锁着时截图会失败，先解锁。

数据全部虚构（工作区 atlas / billing，上传测试与账单导出的对话），状态目录和 lintel 目录都在
macos/build/readme-media/ 下（不进仓库），不读也不写你真实的 ~/.claude/willow 与 lintel 目录。
拍摄时会停掉正在跑的 lintel 宿主（刘海只能有一个宿主），拍完用同一个二进制重新起一个，日志进
macos/build/readme-media/host.log。收起、悬停两幕先在刘海下铺一层黑底（lintel 的 --backdrop），
不会拍进别的窗口；弹出框与窗口按它们自己的外框截。
"""
import datetime, json, os, pathlib, shutil, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parents[2]
APP = ROOT / "macos/.build/release/WishingWillow"
LINTEL = pathlib.Path(os.environ.get("LINTEL_BIN", ROOT.parent / "lintel/.build/release/lintel"))
HOOKS = ROOT / "plugin/hooks"
OUT = ROOT / "docs/media"
WORK = ROOT / "macos/build/readme-media"
SCENES = sys.argv[1:] or ["compact", "arrival", "hover", "popover", "list", "turns"]

TEXT = {
    "zh": {
        "main_title": "修上传测试",
        "other_title": "账单按月导出",
        "p1": "上传测试为什么只在 CI 上挂？先找原因，别改代码。",
        "d1": ("你批准的：只找出上传测试为什么只在 CI 上失败，不改代码。\n"
               "我读成了：只读排查上传测试在 CI 上失败的原因，找到后先报告，不动代码。\n"
               "我补上的：排查范围定为 upload/ 与 CI 配置。\n"
               "标签：查 CI 失败"),
        "p2": "原因找到了就好。把重试改成指数退避，然后跑一遍测试。",
        "d2": ("你批准的：把重试改成指数退避并跑测试。\n"
               "我读成了：重写上传测试的整套重试逻辑，顺手把超时也改掉。\n"
               "我补上的：把「改重试策略」扩成「重写重试逻辑」；超时一起改。\n"
               "标签：改重试策略"),
        "p_other": "把账单导出改成按月分文件。",
        "list": ["+ 在做：找出 CI 失败原因",
                 "L1 做完：upload_test.go 里时区写死",
                 "+ 在做：重试改成指数退避",
                 "+ 等你：要不要顺手把超时从 5 秒改成 10 秒",
                 "+ 等 CI：推上去以后看 Linux 那一路",
                 "+ 以后：给上传加一个本地可复现的 CI 环境"],
    },
    "en": {
        "main_title": "Fix the upload test",
        "other_title": "Monthly billing export",
        "p1": "Why does the upload test fail only on CI? Find the cause first — don't change any code.",
        "d1": ("You approved: find out why the upload test fails only on CI, without changing code.\n"
               "How I read it: Read-only look at why the upload test fails on CI; report the cause before touching code.\n"
               "What I filled in: limited the search to upload/ and the CI config.\n"
               "Tag: CI failure"),
        "p2": "Good, that's the cause. Switch the retry to exponential backoff, then run the tests.",
        "d2": ("You approved: switch the retry to exponential backoff and run the tests.\n"
               "How I read it: Rewrite the whole retry logic of the upload test, and change the timeout while I'm there.\n"
               "What I filled in: widened \"change the retry policy\" to \"rewrite the retry logic\"; the timeout too.\n"
               "Tag: Rewrite retry"),
        "p_other": "Split the billing export into one file per month.",
        "list": ["+ 在做：find why CI fails",
                 "L1 做完：a time zone hard-coded in upload_test.go",
                 "+ 在做：switch the retry to exponential backoff",
                 "+ 等你：raise the timeout from 5 s to 10 s while we're here?",
                 "+ 等 CI：the Linux job after the push",
                 "+ 以后：a local environment that reproduces CI for uploads"],
    },
}


def log(msg):
    print(datetime.datetime.now().strftime("%H:%M:%S"), msg, flush=True)


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def run(cmd, env=None, stdin=None):
    r = subprocess.run(cmd, env={**os.environ, **(env or {})}, input=stdin, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"失败：{' '.join(map(str, cmd))}\n{r.stderr.strip()[:400]}")
    return r.stdout


def rows(path, items):
    with open(path, "a") as f:
        for r in items:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def assistant(text=None, thinking=False, tool=None):
    content = ([{"type": "thinking", "thinking": ""}] if thinking else
               [{"type": "tool_use", "id": "t" + str(time.time_ns()), "name": tool[0], "input": tool[1]}] if tool else
               [{"type": "text", "text": text}])
    return {"type": "assistant", "isSidechain": False, "timestamp": now(),
            "message": {"id": "m" + str(time.time_ns()), "role": "assistant", "model": "claude-opus-5",
                        "usage": {"input_tokens": 3, "cache_creation_input_tokens": 2400,
                                  "cache_read_input_tokens": 412000, "output_tokens": 900},
                        "content": content}}


def turn(state, sid, cwd, prompt, title):
    """一轮开始：会话记录里写一行用户消息和桌面端的标题，再按真实顺序调插件的 capture 钩子。"""
    t = state / f"{sid}.transcript.jsonl"
    rows(t, [{"type": "user", "timestamp": now(), "origin": {"kind": "human"}, "message": {"role": "user", "content": prompt}},
             {"type": "custom-title", "customTitle": title, "sessionId": sid}])
    hook = {"session_id": sid, "hook_event_name": "UserPromptSubmit", "cwd": cwd, "prompt_id": f"p-{sid}-{time.time_ns()}",
            "transcript_path": str(t), "prompt": prompt}
    run(["node", str(HOOKS / "capture.mjs")], env={"WILLOW_STATE_DIR": str(state)}, stdin=json.dumps(hook, ensure_ascii=False))
    # 演示进程早就退出了，pid 记成 1（launchd，永远在），免得被当成已关闭的会话。
    p = state / f"{sid}.json"
    d = json.loads(p.read_text())
    d["pid"] = 1
    p.write_text(json.dumps(d, ensure_ascii=False))
    return t


def end(state, sid, cwd, declaration):
    stop = {"session_id": sid, "hook_event_name": "Stop", "cwd": cwd, "stop_hook_active": False,
            "transcript_path": str(state / f"{sid}.transcript.jsonl"), "last_assistant_message": declaration}
    run(["node", str(HOOKS / "extract.mjs")], env={"WILLOW_STATE_DIR": str(state)}, stdin=json.dumps(stop, ensure_ascii=False))


def build(lang):
    """两场会话：主会话已经走完一轮、第二轮刚写出理解（有一张长清单）；另一场在跑。"""
    x = TEXT[lang]
    state, home = WORK / f"state-{lang}", WORK / f"lintel-{lang}"
    for d in (state, home):
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True)
    main, other = f"media-main-{lang}", f"media-other-{lang}"
    t = turn(state, main, "/work/atlas", x["p1"], x["main_title"])
    rows(t, [assistant(thinking=True), assistant(x["d1"]),
             assistant(tool=("Grep", {"pattern": "retry"})), assistant(tool=("Read", {"file_path": "/work/atlas/upload/upload_test.go"}))])
    end(state, main, "/work/atlas", x["d1"])
    run(["node", str(HOOKS / "listctl.mjs"), "--session", main, *x["list"]], env={"WILLOW_STATE_DIR": str(state)})
    t = turn(state, main, "/work/atlas", x["p2"], x["main_title"])
    rows(t, [assistant(thinking=True), assistant(x["d2"]), assistant(tool=("Edit", {"file_path": "/work/atlas/upload/retry.go"}))])
    end(state, main, "/work/atlas", x["d2"])   # 最近发生的是「理解到达」：刘海弹出的是原话与理解的对照
    t2 = turn(state, other, "/work/billing", x["p_other"], x["other_title"])
    rows(t2, [assistant(thinking=True)])
    env = {"WILLOW_STATE_DIR": str(state), "WILLOW_LANG": lang, "LINTEL_HOME": str(home)}
    log(run([str(APP), "--lintel-export", str(home), "--with-registry"], env=env).strip())
    bad = run([str(LINTEL), "validate"], env={"LINTEL_HOME": str(home)}).strip().splitlines()[-1]
    log(bad)
    return home, main


WINDOWS = """import AppKit
let l = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in l where (w[kCGWindowOwnerName as String] as? String) == "lintel" {
  let b = w[kCGWindowBounds as String] as! [String: Double]
  print(w[kCGWindowLayer as String] as? Int ?? -1, Int(b["X"]!), Int(b["Y"]!), Int(b["Width"]!), Int(b["Height"]!), w[kCGWindowNumber as String] as? Int ?? 0) }"""


def hosts():
    return [int(p) for p in subprocess.run(["pgrep", "-f", "lintel host"], capture_output=True, text=True).stdout.split()]


def notch_center():
    w = subprocess.run(["osascript", "-l", "JavaScript", "-e",
                        'ObjC.import("AppKit"); $.NSScreen.screens.objectAtIndex(0).frame.size.width'],
                       capture_output=True, text=True).stdout.strip()
    return int(float(w) / 2)


def shoot(home, lang, out, flags, pick):
    """起一个演示宿主，等画面出来，按 pick 选的矩形截图；宿主自己在 --present 时间到了退出。"""
    p = subprocess.Popen([str(LINTEL), "host", "--present", "8", *flags], env={**os.environ, "LINTEL_HOME": str(home), "LINTEL_LANG": lang},
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    time.sleep(8)
    wins = [list(map(int, r.split())) for r in subprocess.run(["swift", "-e", WINDOWS], capture_output=True, text=True).stdout.splitlines()]
    target = pick(wins)
    if not target:
        p.kill()
        raise SystemExit(f"{out.name}：没找到要拍的窗口：{wins}")
    if isinstance(target, int):
        # 只拍这一个窗口（带透明边和阴影），外框里露出来的别的窗口一概不进画面。
        subprocess.run(["screencapture", "-x", "-l", str(target), str(out)], check=True)
    else:
        subprocess.run(["screencapture", "-x", "-R" + ",".join(map(str, target)), str(out)], check=True)
    log(f"静帧 {out.name} {target}")
    try:
        p.wait(14)
    except subprocess.TimeoutExpired:
        p.kill()


def main():
    for f in (APP, LINTEL):
        if not f.exists():
            raise SystemExit(f"缺构建：{f}")
    OUT.mkdir(parents=True, exist_ok=True)
    was_running = bool(hosts())
    real = [l for l in subprocess.run(["ps", "-o", "command=", "-p", ",".join(map(str, hosts()))], capture_output=True, text=True).stdout.splitlines()] if was_running else []
    for pid in hosts():
        os.kill(pid, 15)
    time.sleep(1.5)
    c = notch_center()
    try:
        for lang in ("en", "zh"):
            home, main_id = build(lang)
            sel = f"willow/{main_id}"
            if "compact" in SCENES:
                shoot(home, lang, OUT / f"compact.{lang}.png", ["--backdrop", "--still", "--pin", sel], lambda w: [c - 300, 0, 600, 60])
            if "arrival" in SCENES:   # Claude 写出理解的那一刻，刘海自己弹出：你的原话和它的理解并排
                shoot(home, lang, OUT / f"arrival.{lang}.png", ["--backdrop", "--pin", sel, "--flash"], lambda w: [c - 360, 0, 720, 260])
            if "hover" in SCENES:
                shoot(home, lang, OUT / f"hover.{lang}.png", ["--backdrop", "--pin", sel], lambda w: [c - 360, 0, 720, 220])
            if "popover" in SCENES:
                shoot(home, lang, OUT / f"popover.{lang}.png", ["--pin", sel, "--popover"],
                      lambda w: next((r[5] for r in w if r[0] > 27 and r[4] > 100), None))
            if "list" in SCENES:
                shoot(home, lang, OUT / f"window-list.{lang}.png", ["--window", "--window-select", sel],
                      lambda w: next((r[5] for r in w if r[0] == 0 and r[4] > 300), None))
            if "turns" in SCENES:
                shoot(home, lang, OUT / f"window-turns.{lang}.png", ["--window", "--window-select", sel, "--window-tab", "turns"],
                      lambda w: next((r[5] for r in w if r[0] == 0 and r[4] > 300), None))
    finally:
        if was_running:
            cmd = real[0].split() if real else [str(LINTEL), "host", "--log"]
            with open(WORK / "host.log", "ab") as lg:
                subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=lg, stderr=lg, start_new_session=True)
            log(f"重新起了宿主：{' '.join(cmd)}")


main()
