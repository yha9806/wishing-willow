import type { Register } from 'claude-code'
import { suggestedReplyOf } from './_reply.mjs'

// 输入框灰字（函数钩子，Claude Code 的新插件接口）：一轮答完后，把「下一步」末尾建议的那句回复
// 放进输入框，当作按 Tab 采用的灰字建议。输入框里已有字或回合还在跑时，引擎不显示它。
// 引擎自己猜的灰字是另调一次模型，插件写不进去；$.prompt.suggest 是写进去的正路。
export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.reason === 'answer') {
      const text = suggestedReplyOf(e.answer)
      if (text !== null) {
        // 回合要真正结束，输入框才收建议：先等一下，没显示就再试一次。
        $.clock.after(800, async () => {
          const shown = await $.prompt.suggest({ text })
          if (!shown.isShown) {
            $.clock.after(2500, () => {
              void $.prompt.suggest({ text })
            })
          }
        })
      }
    }
    return done
  })
}
