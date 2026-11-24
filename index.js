/**
 * dsh-subagent-quota — a delegation tool with a per-caller soft quota.
 *
 * The stock `@deepseek-ai/dsh-tool-subagent` has one policy knob (`maxDepth`)
 * and no notion of "how many children may this agent hold". This plugin mirrors
 * that tool's surface and inserts one check before `ctx.subagents.startActivation`:
 *
 *   1. a synchronous in-process reservation (closes the parallel-call window),
 *   2. a census of the caller's existing children via `listDescendants`,
 *   3. rejection with an actionable message when the quota is reached.
 *
 * Rejection happens *before* creation, so a refused call leaves no Session and
 * no catalog entry behind.
 *
 * Mount it per Agent Preset in place of the stock tool row. Do not keep both:
 * a session that still has the stock row can bypass the quota entirely.
 */

export const name = 'subagent-quota'
export const inject = ['subagents', 'tools']

const DEFAULTS = {
  provider: 'spawn',
  toolName: 'subagent',
  maxChildren: 3,
  countScope: 'children',
  countIdle: false,
  maxIdleChildren: 0,
  modelSelection: false,
  modelDiscovery: false,
  agentOptions: undefined,
  statusToolName: '',
  agentPreset: '',
  maxDepth: undefined,
}

function normalize(config) {
  const out = { ...DEFAULTS }
  if (config && typeof config === 'object') {
    for (const [key, value] of Object.entries(config)) {
      if (value === undefined || value === null) continue
      if (key in DEFAULTS) out[key] = value
    }
  }
  if (out.countScope !== 'children' && out.countScope !== 'tree') out.countScope = 'children'
  const max = Number(out.maxChildren)
  if (!Number.isSafeInteger(max) || max < 0) throw new Error('subagent-quota: maxChildren must be a non-negative integer')
  out.maxChildren = max
  return out
}

/** Count existing children of `parent` under the configured scope. */
async function census(subagents, parent, cfg, signal) {
  let rows
  try {
    rows = await subagents.listDescendants(parent.id, signal)
  } catch (error) {
    // A quota must not fail the delegation open on a listing hiccup, but it must
    // not silently pretend the tree is empty either: report the degraded count.
    return { count: 0, degraded: error instanceof Error ? error.message : String(error) }
  }
  let considered = Array.isArray(rows) ? rows.filter((row) => row && row.kind === 'child') : []
  if (cfg.countScope === 'children') considered = considered.filter((row) => row.parentId === parent.id)
  const runningRows = considered.filter((row) => row.activity === 'running')
  const running = runningRows.length
  const idle = considered.length - running
  // Idle (finished but resident) children are continuable sessions, not work:
  // count them only when explicitly configured to.
  return {
    count: cfg.countIdle === true ? considered.length : running,
    running,
    idle,
    runningIds: new Set(runningRows.map((row) => String(row.id))),
    degraded: undefined,
  }
}

function quotaMessage(cfg, used, inflight) {
  const total = used + inflight
  if (cfg.maxChildren === 0) {
    return 'subagent delegation is disabled by this preset (quota 0): carry out the work yourself '
      + 'instead of delegating.'
  }
  const scope = cfg.countScope === 'children' ? 'direct children' : 'descendants in this tree'
  const idle = cfg.countIdle === true ? 'including idle ones' : 'running only; finished children do not hold a slot'
  return 'subagent quota reached: this preset allows at most '
    + `${cfg.maxChildren} ${scope} (${idle}), and you already hold ${total}`
    + `${inflight > 0 ? ` (${used} existing + ${inflight} starting)` : ''}. `
    + 'Reuse an existing child with send_message, wait for one to finish, or carry out the work yourself.'
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config = {}) {
  const cfg = normalize(config)
  /**
   * @type {Map<string, Array<{ childId: string | null }>>}
   * caller session id -> reservations held until the child settles. Each entry
   * carries the child id once known, so it can be de-duplicated against the
   * census (a starting child that already appears as running is not counted twice).
   */
  const inflight = new Map()

  /** Settled child handles per caller, oldest first, for optional recycling. */
  const settled = new Map()

  /**
   * Dispose the oldest finished children so they stop holding an instance slot.
   * Disposal ends the activation, not the Session: the child stays continuable
   * and can be cold-resumed by a later message.
   */
  const recycle = async (parentId) => {
    const keep = Number(cfg.maxIdleChildren) || 0
    const list = settled.get(parentId)
    if (!list || list.length <= keep) return 0
    let disposed = 0
    while (list.length > keep) {
      const handle = list.shift()
      try {
        await handle.dispose()
        disposed += 1
      } catch {
        /* a failed disposal must not fail the delegation */
      }
    }
    return disposed
  }

  const reserve = (id) => {
    const held = { childId: null }
    const list = inflight.get(id) ?? []
    list.push(held)
    inflight.set(id, list)
    return held
  }
  const release = (id, held) => {
    const list = inflight.get(id)
    if (!list) return
    const index = list.indexOf(held)
    if (index >= 0) list.splice(index, 1)
    if (list.length === 0) inflight.delete(id)
  }
  /** Reservations that the census does not already report as running. */
  const outstanding = (id, runningIds) => (inflight.get(id) ?? [])
    .filter((held) => held.childId === null || !runningIds.has(held.childId))
    .length

  const disposers = []

  /** Resolve configured defaults plus the model request into child agentOptions. */
  const resolveAgentOptions = async (args, signal) => {
    const configured = cfg.agentOptions && typeof cfg.agentOptions === 'object' ? { ...cfg.agentOptions } : {}
    const requested = {}
    if (typeof args?.provider === 'string' && args.provider) requested.provider = args.provider
    if (typeof args?.model === 'string' && args.model) requested.model = args.model
    if (typeof args?.reasoning_effort === 'string' && args.reasoning_effort) requested.reasoningEffort = args.reasoning_effort
    const merged = { ...configured }
    if (Object.keys(requested).length === 0) return Object.keys(merged).length ? merged : undefined

    if (requested.provider === undefined || requested.model === undefined) {
      throw new Error('invalid arguments: `provider` and `model` must be given together')
    }
    const llm = ctx.get?.('llm')
    if (llm === undefined) {
      throw new Error('cannot validate the requested child route because the `llm` service is unavailable')
    }
    // resolveModelInfo validates that an adapter owns this exact route.
    const info = await llm.resolveModelInfo(requested.provider, requested.model, signal)
    if (requested.reasoningEffort !== undefined) {
      const efforts = (info?.reasoning?.efforts ?? []).map((e) => String(e.id))
      if (efforts.length > 0 && !efforts.includes(requested.reasoningEffort)) {
        throw new Error(
          `invalid arguments: reasoning_effort "${requested.reasoningEffort}" is not offered by `
          + `${requested.provider}/${requested.model} (available: ${efforts.join(', ')})`,
        )
      }
    }
    merged.provider = requested.provider
    merged.model = requested.model
    if (requested.reasoningEffort !== undefined) merged.reasoningEffort = requested.reasoningEffort
    return merged
  }

  const definition = {
    name: cfg.toolName,
    description:
      'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
      + 'to offload focused, independent work — research, a scoped implementation, an analysis — so it does '
      + 'not consume this conversation\'s context. The subagent returns its result, not its intermediate steps. '
      + 'This tool starts an independently managed subagent and immediately returns its name. '
      + `It enforces a quota of at most ${cfg.maxChildren} `
      + `${cfg.countScope === 'children' ? 'direct children' : 'descendants'} per agent; `
      + 'when the quota is reached it rejects instead of starting a child, so reuse an existing child or do the work yourself.',
    // Compiled JSON Schema (what defineTool would store). The raw author DSL is
    // not a wire schema: a provider rejects `{ type: 'string', required: true }`.
    parameters: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Initial child working directory. Relative paths use your current directory; omitted inherits it.',
        },
        description: {
          type: 'string',
          description: 'A short (3-5 word) description of the delegated task, for display. Use the language of the user\'s current request.',
        },
        name: {
          type: 'string',
          description: 'Optional short name, unique among the subagents you create: lower-case letters, digits, hyphen, starting with a letter, at most 32 characters; `lead` is reserved. Omitted names default to agent-1, agent-2, and so on.',
        },
        prompt: {
          type: 'string',
          description: 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.',
        },
        ...cfg.modelSelection ? {
          provider: {
            type: 'string',
            description: 'Child LLM provider id; requires `model`. Omit to inherit the child default route.',
          },
          model: {
            type: 'string',
            description: 'Model id within that provider; requires `provider`. Omit to inherit the child default route.',
          },
          reasoning_effort: {
            type: 'string',
            description: 'Reasoning effort id; requires `provider` and `model`. Omit to use the model default.',
          },
        } : {},      },
      required: ['description', 'prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'activation' },
          name: { type: 'string' },
        },
        required: ['kind', 'name'],
      },
      render: (_args, value) => [{ type: 'text', text: `started subagent ${value.name}` }],
      presentationMeta: (_args, value) => ({ kind: value.kind, name: value.name }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec?.agent
      if (!parent) throw new Error('subagent-quota: this tool requires a calling agent (exec.agent was undefined)')
      const signal = exec.signal
      if (typeof args?.prompt !== 'string' || args.prompt.trim() === '') {
        throw new Error('invalid arguments: `prompt` must be a non-empty string')
      }
      if (typeof args?.description !== 'string' || args.description.trim() === '') {
        throw new Error('invalid arguments: `description` must be a non-empty string')
      }

      await recycle(parent.id)
      // Reserve before any await: parallel calls in one step cannot both pass
      // the census below. The reservation carries the child id once startActivation
      // returns, so `outstanding` can drop it as soon as the census reports it.
      const held = reserve(parent.id)
      try {
        const { count, runningIds, degraded } = await census(ctx.subagents, parent, cfg, signal)
        const starting = outstanding(parent.id, runningIds)
        if (count + starting > cfg.maxChildren) {
          const message = quotaMessage(cfg, count, starting)
          throw new Error(degraded ? `${message} (census degraded: ${degraded})` : message)
        }
        signal?.throwIfAborted?.()

        const childAgentOptions = await resolveAgentOptions(args, signal)
        const resolvedDepth = typeof ctx.subagents.resolveMaxDepth === 'function'
          ? ctx.subagents.resolveMaxDepth(cfg.maxDepth)
          : undefined
        const started = await ctx.subagents.startActivation({
          provider: cfg.provider,
          label: args.description,
          ...args.name === undefined ? {} : { name: args.name },
          ...args.cwd === undefined ? {} : { cwd: args.cwd },
          prompt: [{ type: 'text', text: args.prompt }],
          parent,
          ...cfg.agentPreset ? { agentPreset: cfg.agentPreset } : {},
          ...childAgentOptions === undefined ? {} : { agentOptions: childAgentOptions },
          ...resolvedDepth === undefined ? {} : { maxDepth: resolvedDepth },
          signal,
          delivery: 'parent',
        })
        held.childId = String(started.childId)
        // Only a FINISHED child may be recycled: a running one is real work.
        started.result.finally(() => {
          release(parent.id, held)
          const list = settled.get(parent.id) ?? []
          list.push({ name: started.name, dispose: () => started.dispose() })
          settled.set(parent.id, list)
        }).catch(() => {})
        return { kind: 'activation', name: started.name }
      } catch (error) {
        release(parent.id, held)
        throw error
      }
    },
  }

  disposers.push(ctx.tools.register(definition))

  if (cfg.modelDiscovery) {
    disposers.push(ctx.tools.register({
      name: 'list_subagent_models',
      description:
        'List the LLM routes a delegated child can be given: for each registered provider, the models it '
        + 'advertises. Pass `provider` to narrow to one provider, or `provider` + `model` to confirm one exact '
        + 'route (and see its reasoning efforts).',
      parameters: {
        type: 'object',
        properties: {
          provider: { type: 'string', description: 'Optional provider id to narrow the listing.' },
          model: { type: 'string', description: 'Optional exact model id; requires `provider`.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            entries: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  provider: { type: 'string' },
                  model: { type: 'string' },
                  name: { type: 'string' },
                  efforts: { type: 'array', items: { type: 'string' } },
                },
                required: ['provider', 'model'],
              },
            },
          },
          required: ['entries'],
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.entries.length === 0
            ? 'list_subagent_models: no routes found'
            : value.entries.map((e) => {
              const efforts = e.efforts?.length ? ` [efforts: ${e.efforts.join(', ')}]` : ''
              return `${e.provider}/${e.model}${e.name && e.name !== e.model ? ` — ${e.name}` : ''}${efforts}`
            }).join('\n'),
        }],
      },
      async execute(args, exec) {
        const llm = ctx.get?.('llm')
        if (llm === undefined) throw new Error('list_subagent_models requires the `llm` service')
        const entries = []
        if (args?.model !== undefined && args?.provider === undefined) {
          throw new Error('invalid arguments: `model` requires `provider`')
        }
        if (args?.provider !== undefined && args?.model !== undefined) {
          const info = await llm.resolveModelInfo(args.provider, args.model, exec.signal)
          entries.push({
            provider: args.provider,
            model: args.model,
            name: String(info?.name ?? args.model),
            efforts: (info?.reasoning?.efforts ?? []).map((e) => String(e.id)),
          })
          return { entries }
        }
        const providers = args?.provider !== undefined
          ? [{ id: args.provider }]
          : (llm.listProviders() ?? [])
        for (const provider of providers) {
          let models = []
          try {
            models = await llm.listModels(provider.id)
          } catch {
            continue
          }
          for (const model of models) {
            entries.push({ provider: provider.id, model: String(model.id), name: String(model.name ?? model.id) })
          }
        }
        return { entries }
      },
    }))
  }

  if (cfg.statusToolName) {
    disposers.push(ctx.tools.register({
      name: cfg.statusToolName,
      description: 'Report the subagent quota for this agent: the configured limit and current usage.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'integer' },
            used: { type: 'integer' },
            running: { type: 'integer' },
            idle: { type: 'integer' },
            starting: { type: 'integer' },
            scope: { type: 'string' },
            remaining: { type: 'integer' },
          },
          required: ['limit', 'used', 'running', 'idle', 'starting', 'scope', 'remaining'],
        },
        render: (_args, value) => [{
          type: 'text',
          text: `subagent quota: ${value.used}/${value.limit} used (${value.running} running, ${value.idle} idle, ${value.starting} starting; scope=${value.scope}); ${value.remaining} remaining`,
        }],
      },
      async execute(_args, exec) {
        const parent = exec?.agent
        if (!parent) throw new Error('subagent-quota: status requires a calling agent')
        const { count, running, idle, runningIds } = await census(ctx.subagents, parent, cfg, exec.signal)
        const starting = outstanding(parent.id, runningIds)
        return {
          limit: cfg.maxChildren,
          used: count + starting,
          running, idle, starting,
          scope: cfg.countScope,
          remaining: Math.max(0, cfg.maxChildren - count - starting),
        }
      },
    }))
  }

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* disposal must not throw out of plugin teardown */
      }
    }
  }
}
