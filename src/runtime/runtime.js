import {set_current_context} from './record_io.js'
import {Multiversion} from './multiversion.js'

// Create separate class to check value instanceof LetMultiversion
export class LetMultiversion extends Multiversion {}

/*
Converts generator-returning function to promise-returning function. Allows to
have the same code both for sync and async. If we have only sync modules (no
toplevel awaits), then code executes synchronously, and if there are async
modules, then code executes asynchronoulsy, but we have syntactic niceties of
'yield', 'try', 'catch'
*/
const gen_to_promise = gen_fn => {
  return (...args) => {
    const gen = gen_fn(...args)
    const next = result => {
      if(result.done){
        return result.value
      } else {
        // If promise
        if(result.value?.then != null) {
          return result.value.__original_then(
            value => next(gen.next(value)),
            error => next(gen.throw(error)),
          )
        } else {
          return next(gen.next(result.value))
        }
      }
    }
    return next(gen.next())
  }
}

const make_promise_with_rejector = cxt => {
  let rejector
  const p = new cxt.window.Promise(r => rejector = r)
  return [p, rejector]
}

const do_run = function*(module_fns, cxt, io_trace){
  let calltree

  const calltree_node_by_loc = new Map(
    module_fns.map(({module}) => [module, new Map()])
  )

  const [replay_aborted_promise, io_trace_abort_replay] = 
    make_promise_with_rejector(cxt)

  cxt = (io_trace == null || io_trace.length == 0)
    // TODO group all io_trace_ properties to single object?
    ? {...cxt,
      calltree_node_by_loc,
      logs: [],
      io_trace_is_recording: true,
      io_trace: [],
    }
    : {...cxt,
      calltree_node_by_loc,
      logs: [],
      io_trace_is_recording: false,
      io_trace,
      io_trace_is_replay_aborted: false,
      io_trace_resolver_is_set: false,
      // Map of (index in io_trace) -> resolve
      io_trace_resolvers: new Map(),
      io_trace_index: 0,
      io_trace_abort_replay,
    }

  apply_promise_patch(cxt)
  set_current_context(cxt)

  for(let i = 0; i < module_fns.length; i++) {
    const {module, fn} = module_fns[i]

    cxt.is_entrypoint = i == module_fns.length - 1

    cxt.children = null
    calltree = {
      toplevel: true, 
      module,
      id: ++cxt.call_counter,
      let_vars: {},
    }

    try {
      cxt.modules[module] = {}
      const result = fn(
        cxt, 
        calltree.let_vars,
        calltree_node_by_loc.get(module),
        __trace, 
        __trace_call, 
        __do_await, 
        __save_ct_node_for_path,
        LetMultiversion,
      )
      if(result instanceof cxt.window.Promise) {
        yield cxt.window.Promise.race([replay_aborted_promise, result])
      } else {
        yield result
      }
      calltree.ok = true
    } catch(error) {
      calltree.ok = false
      calltree.error = error
    }
    calltree.children = cxt.children
    calltree.next_id = cxt.call_counter + 1
    if(!calltree.ok) {
      break
    }
  }

  cxt.is_recording_deferred_calls = true
  const _logs = cxt.logs
  cxt.logs = []
  cxt.children = null

  remove_promise_patch(cxt)

  return {
    modules: cxt.modules,
    calltree,
    logs: _logs,
    rt_cxt: cxt,
    calltree_node_by_loc,
  }
}

export const run = gen_to_promise(function*(module_fns, cxt, io_trace) {
  const result = yield* do_run(module_fns, cxt, io_trace)

  if(result.rt_cxt.io_trace_is_replay_aborted) {
    // TODO test next line
    result.rt_cxt.is_recording_deferred_calls = false

    // run again without io trace
    return yield* do_run(module_fns, cxt, null)
  } else {
    return result
  }
})


const apply_promise_patch = cxt => {
  const original_then = cxt.window.Promise.prototype.then
  cxt.window.Promise.prototype.__original_then = cxt.window.Promise.prototype.then

  cxt.window.Promise.prototype.then = function then(on_resolve, on_reject) {

    if(cxt.children == null) {
      cxt.children = []
    }
    let children_copy = cxt.children

    const make_callback = (cb, ok) => typeof(cb) != 'function'
      ? cb
      : value => {
          if(this.status == null) {
            this.status = ok ? {ok, value} : {ok, error: value}
          }
          const current = cxt.children
          cxt.children = children_copy
          try {
            return cb(value)
          } finally {
            cxt.children = current
          }
        }

    return original_then.call(
      this,
      make_callback(on_resolve, true),
      make_callback(on_reject, false),
    )
  }
}

const remove_promise_patch = cxt => {
  cxt.window.Promise.prototype.then = cxt.window.Promise.prototype.__original_then
}

export const set_record_call = cxt => {
  for(let i = 0; i < cxt.stack.length; i++) {
    cxt.stack[i] = true
  }
}

export const do_eval_expand_calltree_node = (cxt, node) => {
  cxt.is_recording_deferred_calls = false
  cxt.is_expanding_calltree_node = true
  cxt.touched_multiversions = new Set()

  // Save call counter and set it to the value it had when executed 'fn' for
  // the first time
  const call_counter = cxt.call_counter
  cxt.call_counter = node.fn.__location == null
    // Function is native, set call_counter to node.id
    ? node.id 
    // call_counter will be incremented inside __trace and produce the same id
    // as node.id
    : node.id - 1 

  cxt.children = null
  try {
    if(node.is_new) {
      new node.fn(...node.args)
    } else {
      node.fn.apply(node.context, node.args)
    }
  } catch(e) {
    // do nothing. Exception was caught and recorded inside '__trace'
  }

  // Restore call counter
  cxt.call_counter = call_counter

  // Recover multiversions affected by expand_calltree_node
  for(let m of cxt.touched_multiversions) {
    if(m.is_expanding_calltree_node) {
      delete m.is_expanding_calltree_node
    }
    if(m.latest_copy != null) {
      m.latest = m.latest_copy.value
    }
  }
  delete cxt.touched_multiversions

  cxt.is_expanding_calltree_node = false
  cxt.is_recording_deferred_calls = true
  const children = cxt.children
  cxt.children = null

  if(node.fn.__location != null) {
    // fn is hosted, it created call, this time with children
    const result = children[0]
    if(result.id != node.id) {
      throw new Error('illegal state')
    }
    result.children = cxt.prev_children
    result.has_more_children = false
    return result
  } else {
    // fn is native, it did not created call, only its child did
    return {...node, 
      children: children,
      has_more_children: false,
    }
  }
}



const __do_await = async (cxt, value) => {
  // children is an array of child calls for current function call. But it
  // can be null to save one empty array allocation in case it has no child
  // calls. Allocate array now, so we can have a reference to this array
  // which will be used after await
  if(cxt.children == null) {
    cxt.children = []
  }
  const children_copy = cxt.children
  if(value instanceof cxt.window.Promise) {
    value.__original_then(
      v => {
        value.status = {ok: true, value: v}
      },
      e => {
        value.status = {ok: false, error: e}
      }
    )
  }
  try {
    return await value
  } finally {
    cxt.children = children_copy
  }
}

const __trace = (cxt, fn, name, argscount, __location, get_closure, has_versioned_let_vars) => {
  const result = (...args) => {
    if(result.__closure == null) {
      result.__closure = get_closure()
    }

    const children_copy = cxt.children
    cxt.children = null
    cxt.stack.push(false)

    const call_id = ++cxt.call_counter

    // populate calltree_node_by_loc only for entrypoint module
    if(cxt.is_entrypoint && !cxt.skip_save_ct_node_for_path) {
      let nodes_of_module = cxt.calltree_node_by_loc.get(__location.module)
      if(nodes_of_module == null) {
        nodes_of_module = new Map()
        cxt.calltree_node_by_loc.set(__location.module, nodes_of_module)
      }
      if(nodes_of_module.get(__location.index) == null) {
        set_record_call(cxt)
        nodes_of_module.set(__location.index, call_id)
      }
    }

    let let_vars
    if(has_versioned_let_vars) {
      let_vars = cxt.let_vars = {}
    }

    let ok, value, error

    const is_toplevel_call_copy = cxt.is_toplevel_call
    cxt.is_toplevel_call = false

    try {
      value = fn(...args)
      ok = true
      if(value instanceof cxt.window.Promise) {
        set_record_call(cxt)
      }
      return value
    } catch(_error) {
      ok = false
      error = _error
      set_record_call(cxt)
      if(cxt.is_recording_deferred_calls && is_toplevel_call_copy) {
        if(error instanceof cxt.window.Error) {
          error.__ignore = true
        }
      }
      throw error
    } finally {

      cxt.prev_children = cxt.children

      const call = {
        id: call_id,
        next_id: cxt.call_counter + 1,
        let_vars,
        ok,
        value,
        error,
        fn: result,
        args: argscount == null 
          ? args
          // Do not capture unused args
          : args.slice(0, argscount),
      }

      const should_record_call = cxt.stack.pop()

      if(should_record_call) {
        call.children = cxt.children
      } else {
        call.has_more_children = cxt.children != null && cxt.children.length != 0
      }
      cxt.children = children_copy
      if(cxt.children == null) {
        cxt.children = []
      }
      cxt.children.push(call)

      cxt.is_toplevel_call = is_toplevel_call_copy

      if(cxt.is_recording_deferred_calls && cxt.is_toplevel_call) {
        if(cxt.children.length != 1) {
          throw new Error('illegal state')
        }
        const call = cxt.children[0]
        cxt.children = null
        const _logs = cxt.logs
        cxt.logs = []
        cxt.on_deferred_call(call, cxt.calltree_changed_token, _logs)
      }
    }
  }

  Object.defineProperty(result, 'name', {value: name})
  result.__location = __location
  return result
}

const __trace_call = (cxt, fn, context, args, errormessage, is_new = false) => {
  if(fn != null && fn.__location != null && !is_new) {
    // Call will be traced, because tracing code is already embedded inside
    // fn
    return fn(...args)
  }

  if(typeof(fn) != 'function') {
    throw new TypeError(
      errormessage 
      + ' is not a ' 
      + (is_new ? 'constructor' : 'function')
    )
  }

  const children_copy = cxt.children
  cxt.children = null
  cxt.stack.push(false)

  const call_id = ++cxt.call_counter

  // TODO: other console fns
  const is_log = fn == cxt.window.console.log || fn == cxt.window.console.error

  if(is_log) {
    set_record_call(cxt)
  }

  let ok, value, error

  try {
    if(!is_log) {
      if(is_new) {
        value = new fn(...args)
      } else {
        value = fn.apply(context, args)
      }
    } else {
      value = undefined
    }
    ok = true
    if(value instanceof cxt.window.Promise) {
      set_record_call(cxt)
    }
    return value
  } catch(_error) {
    ok = false
    error = _error
    set_record_call(cxt)
    throw error
  } finally {

    cxt.prev_children = cxt.children

    const call = {
      id: call_id,
      next_id: cxt.call_counter + 1,
      ok,
      value,
      error,
      fn,
      args,
      context,
      is_log,
      is_new,
    }
    
    if(is_log) {
      cxt.logs.push(call)
    }

    const should_record_call = cxt.stack.pop()

    if(should_record_call) {
      call.children = cxt.children
    } else {
      call.has_more_children = cxt.children != null && cxt.children.length != 0
    }

    cxt.children = children_copy
    if(cxt.children == null) {
      cxt.children = []
    }
    cxt.children.push(call)
  }
}

const __save_ct_node_for_path = (cxt, __calltree_node_by_loc, index, __call_id) => {
  if(!cxt.is_entrypoint) {
    return
  }

  if(cxt.skip_save_ct_node_for_path) {
    return
  }
  if(__calltree_node_by_loc.get(index) == null) {
    __calltree_node_by_loc.set(index, __call_id)
    set_record_call(cxt)
  }
}