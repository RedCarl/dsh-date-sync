/**
 * Executes the Client half in a bare VM: no DOM and no React rendering, only
 * the module registration, factory return shape, and slot/locale calls that
 * `apply` makes. This catches reference errors and wrong registration keys
 * without pretending to verify appearance.
 *
 * Run with: node test/client-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let registration
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
  },
  fetch: () => Promise.resolve({ ok: true, text: () => Promise.resolve('{}') }),
  console,
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
}
vm.runInNewContext(source, sandbox, { filename: 'client.js' })

let passed = 0
const failures = []
function check(name, operation) {
  try {
    operation()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`  FAIL ${name}\n       ${error?.stack ?? error}`)
  }
}

check('registers a factory under the package name', () => {
  assert.ok(registration, 'window.__ModuleLoader__.load was not called')
  assert.equal(registration.id, 'dsh-date-sync')
  assert.equal(typeof registration.factory, 'function')
})

let clientModule
check('factory materializes with the browser module table', () => {
  const React = {
    createElement(type, props, ...children) {
      return { type, props, children }
    },
    useReducer(initial) { return [initial, () => {}] },
    useState(initial) { return [initial, () => {}] },
    useEffect() {},
    useMemo(factory) { return factory() },
    useCallback(factory) { return factory },
    useRef(value) { return { current: value } },
  }
  clientModule = registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected external: ${specifier}`)
  })
  assert.equal(Array.from(clientModule.inject).join(','), 'slots,locale')
  assert.equal(typeof clientModule.apply, 'function')
})

check('apply registers dictionaries, the sidebar icon, and the main panel', () => {
  const registrations = []
  const effects = []
  const ctx = {
    effect(factory) {
      const dispose = factory()
      effects.push(dispose)
      return dispose
    },
    locale: {
      register(namespace, dictionaries) {
        registrations.push({ kind: 'locale', namespace, locales: Object.keys(dictionaries) })
        return () => {}
      },
      bind(namespace) {
        return (key) => `${namespace}:${key}`
      },
      subscribe() {
        return () => {}
      },
      getLocale() {
        return { active: 'zh' }
      },
    },
    slots: {
      inject(name, callback) {
        registrations.push({ kind: 'inject', name })
        return callback()
      },
      register(options, component) {
        registrations.push({ kind: 'register', options, component })
        return () => {}
      },
    },
  }

  clientModule.apply(ctx)

  const locale = registrations.find((entry) => entry.kind === 'locale')
  assert.ok(locale, 'locale dictionaries were not registered')
  assert.equal(locale.namespace, 'date-sync')
  assert.deepEqual(locale.locales.sort(), ['en', 'zh'])

  const icon = registrations.find((entry) => entry.kind === 'register' && entry.options.name === 'sidebar.panellist')
  assert.ok(icon, 'sidebar.panellist was not registered')
  assert.equal(icon.options.id, 'date-sync')
  assert.equal(typeof icon.options.label, 'function')
  assert.equal(typeof icon.component, 'function')

  const main = registrations.find((entry) => entry.kind === 'register' && entry.options.name === 'main')
  assert.ok(main, 'main panel was not registered')
  assert.equal(main.options.key, 'date-sync')
  assert.equal(typeof main.component, 'function')

  const wrapper = icon.component({ size: 20, active: false })
  assert.equal(typeof wrapper.type, 'function')
  const svg = wrapper.type(wrapper.props)
  assert.equal(svg.type, 'svg')
  assert.equal(svg.props.width, 20)
  assert.equal(svg.props.viewBox, '0 0 24 24')
  assert.ok(Array.isArray(svg.children) && svg.children.length >= 5)
  // Idle state renders no badge at all; the dot lives inside the 24-unit SVG
  // box and inherits the same geometry as the balance-panel indicator.
  assert.equal(svg.children.filter((child) => child && child.type === 'circle').length, 0)

  const mainWrapper = main.component({})
  assert.equal(typeof mainWrapper.type, 'function')
  const page = mainWrapper.type(mainWrapper.props)
  assert.equal(page.type, 'div')
  assert.ok(JSON.stringify(page).includes('dws-segmented'))

  for (const dispose of effects) {
    if (typeof dispose === 'function') dispose()
  }
})

check('all visible strings exist in both dictionaries', () => {
  // The module keeps dictionaries private; re-execute with a recording locale
  // service to compare key sets through what `apply` registered.
  let captured
  const sandbox2 = {
    window: { __ModuleLoader__: { load: (value) => { captured = value } } },
    fetch: () => Promise.resolve({ ok: true, text: () => Promise.resolve('{}') }),
    console,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(source, sandbox2, { filename: 'client.js' })
  const module = captured.factory((specifier) => {
    if (specifier !== 'react') throw new Error(specifier)
    return {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useReducer: (initial) => [initial, () => {}],
      useState: (initial) => [initial, () => {}],
      useEffect() {},
      useMemo: (factory) => factory(),
      useCallback: (factory) => factory,
      useRef: (value) => ({ current: value }),
    }
  })
  let dictionaries
  module.apply({
    effect: (factory) => factory(),
    locale: {
      register(namespace, dicts) { dictionaries = dicts; return () => {} },
      bind: () => (key) => key,
      subscribe: () => () => {},
      getLocale: () => ({ active: 'en' }),
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: () => () => {},
    },
  })
  const zh = Object.keys(dictionaries.zh).sort()
  const en = Object.keys(dictionaries.en).sort()
  assert.deepEqual(zh, en)
  for (const key of en) {
    assert.ok(dictionaries.zh[key].length > 0, `empty zh translation for ${key}`)
    assert.ok(dictionaries.en[key].length > 0, `empty en translation for ${key}`)
  }
})

console.log(`\n${passed} checks passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error?.message ?? failure.error}`)
  process.exitCode = 1
}
