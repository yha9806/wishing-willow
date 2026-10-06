# Wishing-Willow app —— 本机编译即用。它读会话、写成 lintel 活动；刘海由 lintel 画（github.com/vulca-org/lintel）。
#
# 不做签名和公证：本地编译出来的二进制不带 quarantine 属性，Gatekeeper 不拦。
# 下载来的 .app 才需要那一套，而这个项目故意不走下载分发。

APP      := WishingWillow
BUNDLE   := build/$(APP).app
BIN      := .build/release/$(APP)
INSTALL  := /Applications/$(APP).app

AGENT    := $(HOME)/Library/LaunchAgents/org.vulca.wishingwillow.plist
LOG      := $(HOME)/Library/Logs/wishing-willow/producer.log

.PHONY: all build app run register install autostart autostart-off test clean

all: app

build:
	swift build -c release

app: build
	@rm -rf "$(BUNDLE)"
	@mkdir -p "$(BUNDLE)/Contents/MacOS" "$(BUNDLE)/Contents/Resources"
	@cp Resources/Info.plist "$(BUNDLE)/Contents/Info.plist"
	@cp "$(BIN)" "$(BUNDLE)/Contents/MacOS/$(APP)"
	@echo "APPL????" > "$(BUNDLE)/Contents/PkgInfo"
	@echo "→ $(BUNDLE)"

run: app
	@pkill -x "$(APP)" 2>/dev/null || true
	@open "$(BUNDLE)"
	@echo "→ 在后台运行；刘海上的会话由 lintel 画（没有 lintel 就什么也看不到）"

# 在 lintel 的登记表里登记许愿柳（事件类型、名字）。装好 lintel 之后跑一次；app 更新后新增了事件类型也要再跑。
register: app
	@"$(BUNDLE)/Contents/MacOS/$(APP)" --lintel-register

install: app
	@rm -rf "$(INSTALL)"
	@cp -R "$(BUNDLE)" "$(INSTALL)"
	@echo "→ $(INSTALL)"

# 登录后自动起 app。指向 build/ 里这一份：本机只留一份，`make app` 换掉的就是开机起的那个，
# 不会出现 /Applications 里的旧版和刚编译的新版各跑各的。只在登录时起一次（RunAtLoad），不 KeepAlive——
# 手动退出或录素材时关掉它，不会被立刻拉起来。装上时会立刻起一次。出错写进 $(LOG)（见 plist 模板）。
autostart:
	@test -d "$(BUNDLE)" || { echo "先 make app"; exit 1; }
	@mkdir -p "$(dir $(AGENT))"
	@sed -e "s|@BUNDLE@|$(abspath $(BUNDLE))|g" -e "s|@LOG@|$(LOG)|g" Resources/org.vulca.wishingwillow.plist.in > "$(AGENT)"
	@launchctl bootout gui/$$(id -u) "$(AGENT)" 2>/dev/null || true
	@launchctl bootstrap gui/$$(id -u) "$(AGENT)"
	@echo "→ $(AGENT)（登录时起 $(abspath $(BUNDLE))；日志 $(LOG)）"

autostart-off:
	@launchctl bootout gui/$$(id -u) "$(AGENT)" 2>/dev/null || true
	@rm -f "$(AGENT)"
	@echo "→ 已取消登录时自动打开"

test:
	@swift test 2>&1 | tee /tmp/willow-macos-test.log | grep -E '✔|✘|⊘|真实文件|Test run'
	@grep -q '⊘ SKIP' /tmp/willow-macos-test.log \
		&& echo "⚠ 有关卡被跳过（见上）—— 跳过不是通过" \
		|| true

clean:
	@rm -rf .build build
