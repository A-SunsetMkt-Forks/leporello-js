const fib = n => {
  if (n == 0) {
    return 0
  }
  if (n == 1) {
    return 1
  }
  return fib(n - 1) + fib(n - 2)
}

/* external */
import { h, render } from "preact"

/* external */
import { Stateful } from "./stateful.js"

const Fibonacci = Stateful({
  getInitialState: () => ({ index: 0 }),

  handlers: {
    prev: ({ index }, event) => ({ index: index - 1 }),
    next: ({ index }, event) => ({ index: index + 1 }),
  },

  render: (props, state, handlers) =>
    h(
      "div",
      null,
      h(
        "h1",
        null,
        "nth Fibonacci number is ",
        fib(state.index),
        " for n = ",
        state.index,
      ),
      h("button", { onClick: handlers.prev }, "Previous"),
      " ",
      h("button", { onClick: handlers.next }, "Next"),
      " ",
    ),
})

render(h(Fibonacci), globalThis.document.body)
