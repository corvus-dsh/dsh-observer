/**
 * The POLICY layer — the words that decide WHEN this plugin may act, and as WHAT.
 *
 * ── v1.6.0: THE THIRD REWRITE OF THIS RULE, AND WHY THE FIRST TWO FAILED OPPOSITE WAYS ──
 *
 * v1.3.x said: "call it only after the user CONFIRMED a plan AND the work is too large for a single
 * context window". Result: a session received 「请先制定计划，然后孵化主脑来执行」, measured the
 * task, decided it was small, wrote the code itself, and on the repeated instruction read it as
 * "a template reminder". The wording made an explicit order into one input of a judgement.
 *
 * v1.4.0 over-corrected to "A REPEATED INSTRUCTION … call this tool NOW". Result, from the next
 * acceptance run: the user said 「先制定计划，然后孵化主脑」 and the session **invented the whole
 * plan on its own, hatched a main, ignited it, and started building** — the user never saw the plan
 * and never agreed to it. In real development that is worse than the first failure: a wrong plan
 * that runs is a wrong plan at scale.
 *
 * So the rule is neither "decide by size" nor "act immediately". It is a SEQUENCE with a gate:
 *
 *   1. 调研与规划  — analyse, research if needed, produce a plan.
 *   2. 对齐与确认  — SHOW the plan and ASK (ask_user_question). Wait.
 *   3. 执行与孵化  — only after an explicit 确认/同意/开始 may `observer_spawn_main` be called.
 *
 * THE GATE IS ENFORCED IN CODE, NOT ONLY IN PROSE. `observer_spawn_main` now REQUIRES
 * `userConfirmed: true`, and refuses without it. Prose is a probability; a required argument the
 * caller must assert, plus a refusal that names the missing step, is the closest thing to a barrier
 * a tool schema can give us. Two failures in a row came from trusting a sentence.
 *
 * Both channels still carry the words: the tool `description` (read when the model considers the
 * tool) and a `systemPrompt.section()` (rendered on EVERY request, immune to compaction). An
 * earlier version had no section at all, which is why one paragraph of prose was able to lose.
 */

/**
 * WHAT THIS TOOL IS, AND THE THREE-STAGE WORKFLOW THAT MUST PRECEDE IT.
 *
 * The order of the clauses matters and is deliberate: identity, then the required sequence, then the
 * hard prohibition, then the distinction from subagent tools. Nothing here offers a size-based
 * shortcut, because a size test is what let a reader outvote its user.
 */
export const SPAWN_MAIN_DESCRIPTION = [
  'Incubate a MAIN session (主脑): a brand-new top-level session with its own full history, in this',
  'session\'s own workspace. THIS session then becomes its observer (副脑), and the new main is',
  'IGNITED — it starts working immediately, without waiting to be opened.',
  '',
  'BECAUSE IT STARTS ON ITS OWN, THE PLAN MUST BE AGREED FIRST. Required workflow:',
  '',
  '  1. RESEARCH & PLAN — analyse the request, research what you need, produce a concrete plan',
  '    (goal, steps, verification).',
  '  2. ALIGN & CONFIRM — present that plan to the user IN FULL and call `ask_user_question`',
  '    asking them to confirm it. Offer at least「确认，开始执行」and「需要调整」.',
  '  3. EXECUTE & INCUBATE — ONLY after the user has explicitly replied 确认 / 同意 / 开始 / 可以',
  '    (or picked the confirm option) may you call this tool, passing `userConfirmed: true`.',
  '',
  'HARD PROHIBITION — DO NOT CALL THIS TOOL ON YOUR OWN INITIATIVE. The precondition is: you have',
  'already shown the plan through `ask_user_question`, and the user has explicitly confirmed it.',
  'Deciding the user "probably agrees", or that the task is simple enough to skip the question, is',
  'exactly the failure this gate exists to stop. A wrong plan that runs on its own is worse than a',
  'slow conversation.',
  '',
  'IF THE TASK TURNS OUT COMPLEX (multiple steps, cross-file, long verification): STOP. Show the plan',
  'and ask for confirmation. If the user has not confirmed, KEEP DISCUSSING — never hatch on your own',
  'authority, and do not quietly do the work yourself instead.',
  '',
  'THE ONE EXCEPTION: the user explicitly says to skip confirmation —「不用确认」「跳过确认」',
  '「别问了直接孵化」. Only words about the CONFIRMATION STEP itself count. 「孵化主脑来执行」is',
  'authorisation to hand off, NOT approval of a plan the user has never seen.',
  '',
  'A REPEATED REQUEST IS NOT APPROVAL EITHER. If the user repeats the instruction, they are saying',
  'the earlier step was not done — so show the plan and ask, now. Do not treat the repetition as',
  'a template reminder, and do not hatch without the answer.',
  '',
  'HOW IT DIFFERS FROM THE BUILT-IN SUBAGENT TOOLS: spawning a subagent (or a teammate) creates a',
  'CHILD that runs inside this session\'s context and reports back; it is a helper you drive. This',
  'tool creates a PEER — a top-level session with its own workspace, its own history and its own id,',
  'which the USER opens and drives, while this session stops being the executor and becomes its',
  'observer.',
  '',
  'The Host creates the session detached (COLD), writes `plan` into it as a VISIBLE user-facing',
  'message (so the user reads the agreed plan in the new window), titles it `[主脑] …`, records the',
  'pair, and answers the new id so the caller can open it.',
].join('\n')

/**
 * The standing rule that rides in the SYSTEM PROMPT of every session in this profile.
 *
 * Kept tight on purpose: a long section is skimmed. What it has to prevent is a session that
 * receives 「制定计划并孵化主脑」 and jumps straight to building.
 */
export const TRIGGER_SECTION_NAME = 'observer:trigger'

export const TRIGGER_SECTION_TEXT = [
  '## 孵化主脑：三段式工作流（不可跳过第 2 段）',
  '',
  '用户要求「制定计划并孵化主脑 / 开新会话执行 / 交手给新窗口」时，**不要立刻孵化**。按顺序走：',
  '',
  '**1. 调研与规划** —— 分析需求，必要时调研，产出一份可执行的计划（目标、步骤、验证）。',
  '',
  '**2. 对齐与确认** —— 把计划**完整展示**给用户，并调用 `ask_user_question` 请他确认。',
  '选项至少包含「确认，开始执行」与「需要调整」。然后**停下等回答**。',
  '',
  '**3. 执行与孵化** —— 只有在用户明确回复「确认 / 同意 / 开始 / 可以」之后，才允许调用',
  '`observer_spawn_main`，并传 `userConfirmed: true`。没有这个参数，工具会直接拒绝。',
  '',
  '用户没确认之前：继续讨论、修改计划。**绝不越权孵化**；也**不要自己把活干完**——那是另一种越权。',
  '',
  '注意：用户说「孵化主脑」只代表授权了**交接这个动作**，不代表批准了**某一份具体计划**。',
  '计划必须先被看见、被同意，才能交给一个会自动开跑的主脑。',
  '',
  '唯一例外：用户明确说了「不用确认 / 跳过确认 / 别问了直接孵化」这类关于**确认环节本身**的话。',
  '',
  '与内置 Subagent 的区别：Subagent 是你在本会话里驱动、干完汇报的子智能体；',
  '`observer_spawn_main` 产出的是一个**平级**的顶级会话（有自己的工作区、历史和 id），',
  '由**用户**打开并驱动，而本会话转为它的观察者。',
].join('\n')

/**
 * What an observer that has already hatched a main must NOT do.
 *
 * The second half of the original incident: after hatching, the observer kept working as if it were
 * still the executor. Its role text said "观察者" but nothing forbade the obvious wrong move.
 */
export const OBSERVER_MISSION_TEXT = (mainSessionId: string): string =>
  [
    `[系统设定] 你是会话 ${mainSessionId} 的副脑（观察者）。`,
    '',
    '你现在**不是执行者**。这个任务的工作已经在主脑会话里进行，由用户驱动。',
    '',
    '你要做的：读主会话语义、澄清需求、指出遗漏与风险、在用户询问时给判断。',
    '你不要做的：不要替主脑写它的交付物，不要在主脑还活着时「顺手把它做完」，',
    '不要因为主脑做得慢就自己接管。用户想让你接手时会明说。',
    '',
    '主脑转生后你会收到新的绑定目标，身份不变。',
  ].join('\n')

/**
 * The refusal text when `userConfirmed` is missing or false.
 *
 * Superseded by `confirmationRefusal()` in `confirmation.ts`, which names WHICH fact was missing
 * (no assertion at all vs. assertion without a recorded question). Kept exported so older callers
 * and tests that reference it keep working — but the tool now uses the more specific one.
 */
export const NOT_CONFIRMED_REFUSAL = [
  '拒绝孵化：缺少用户确认（userConfirmed 不是 true）。',
  '',
  '这个工具会创建一个**自动开跑**的主脑，所以计划必须先被用户看到并同意。你现在应当：',
  '',
  '1. 把计划**完整**写出来（目标、步骤、验证），不要只说「我打算这么做」；',
  '2. 调用 `ask_user_question` 请用户确认，选项至少包含「确认，开始执行」与「需要调整」；',
  '3. 等用户明确回复「确认 / 同意 / 开始 / 可以」之后，再调用本工具并传 `userConfirmed: true`。',
  '',
  '如果用户还没确认，就继续讨论计划。**不要**为了通过这个检查而把 userConfirmed 直接设为 true。',
].join('\n')

/**
 * Whether a session that has hatched a main is still allowed to execute.
 *
 * Exported as a decision function rather than a sentence so a test can pin the rule, and so the
 * same answer is available to any future guard. `role` is what the pair table stores.
 */
export function permitsExecution(role: 'main' | 'observer' | ''): boolean {
  // An observer must not act as the executor. A session with NO pair is an ordinary session and
  // may do whatever the user asks.
  return role !== 'observer'
}
