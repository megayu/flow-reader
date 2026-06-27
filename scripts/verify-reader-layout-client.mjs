import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { chromium } from '@playwright/test'

const CDP_URL = process.env.FLOW_READER_CDP_URL ?? 'http://127.0.0.1:9351'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fail(message, detail) {
  const error = new Error(message)
  error.detail = detail
  throw error
}

function assert(condition, message, detail) {
  if (!condition) fail(message, detail)
}

function makeBook(filePath, title, prefix, chapterCount, paragraphs) {
  const parts = [title, '']
  for (let i = 1; i <= chapterCount; i += 1) {
    parts.push(`第${i}章 ${prefix} CHAPTER ${i}`)
    for (let p = 0; p < paragraphs; p += 1) {
      parts.push(
        `${prefix}-${String(i).padStart(3, '0')}-${String(p).padStart(
          2,
          '0',
        )} ${title} ${prefix} ${prefix} ${prefix} 真实客户端确定性布局验证。`.repeat(
          3,
        ),
      )
    }
    parts.push('')
  }
  fs.writeFileSync(filePath, parts.join('\n'), 'utf8')
}

function powershell(command) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

function setFlowWindowBounds(width, height, x = 40, y = 40) {
  powershell(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FlowWin32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@
$p = Get-Process -Name flow-reader | Sort-Object StartTime -Descending | Select-Object -First 1
if (-not $p) { throw 'flow-reader process not found' }
$h = $p.MainWindowHandle
if ($h -eq 0) { throw 'flow-reader MainWindowHandle is 0' }
[FlowWin32]::ShowWindow($h, 9) | Out-Null
Start-Sleep -Milliseconds 100
[FlowWin32]::SetWindowPos($h, [IntPtr]::Zero, ${x}, ${y}, ${width}, ${height}, 0x0040) | Out-Null
`)
}

function maximizeFlowWindow() {
  powershell(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FlowWin32Max {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$p = Get-Process -Name flow-reader | Sort-Object StartTime -Descending | Select-Object -First 1
if (-not $p) { throw 'flow-reader process not found' }
$h = $p.MainWindowHandle
if ($h -eq 0) { throw 'flow-reader MainWindowHandle is 0' }
[FlowWin32Max]::ShowWindow($h, 3) | Out-Null
`)
}

async function invoke(page, command, args) {
  return page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  )
}

async function ensureReaderMode(page) {
  for (let i = 0; i < 3; i += 1) {
    const libraryOverlay = await page.evaluate(
      () =>
        !!document.querySelector(
          '.absolute.inset-0.z-10.min-h-0.overflow-hidden.flow-bg-content',
        ),
    )
    if (!libraryOverlay) return
    await page.keyboard.press('l')
    await wait(700)
  }

  const libraryOverlay = await page.evaluate(
    () =>
      !!document.querySelector(
        '.absolute.inset-0.z-10.min-h-0.overflow-hidden.flow-bg-content',
      ),
  )
  assert(!libraryOverlay, 'failed to enter reader mode')
}

async function isSidebarVisible(page) {
  return page.evaluate(() => {
    const sidebar = document.querySelector('.SideBar')
    if (!sidebar) return false
    const rect = sidebar.getBoundingClientRect()
    const style = getComputedStyle(sidebar)
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      rect.width > 10 &&
      rect.height > 10
    )
  })
}

async function ensureSidebar(page, visible) {
  await ensureReaderMode(page)
  for (let i = 0; i < 4; i += 1) {
    if ((await isSidebarVisible(page)) === visible) return
    const clicked = await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('button')).find(
        (el) => {
          const label = el.getAttribute('aria-label') || ''
          return label === '目录' || label === 'TOC'
        },
      )
      button?.click()
      return !!button
    })
    assert(clicked, 'TOC/sidebar button not found')
    await waitForSettled(page, `sidebar ${visible ? 'open' : 'closed'}`)
  }
  assert(
    (await isSidebarVisible(page)) === visible,
    `sidebar did not become ${visible ? 'open' : 'closed'}`,
  )
}

async function readState(page) {
  return page.evaluate(() => {
    const normalize = (text) =>
      String(text ?? '')
        .replace(/\s+/g, ' ')
        .trim()
    const hash = (text) => {
      let value = 2166136261
      const input = normalize(text)
      for (let i = 0; i < input.length; i += 1) {
        value ^= input.charCodeAt(i)
        value = Math.imul(value, 16777619)
      }
      return (value >>> 0).toString(16)
    }
    const rectOf = (el) => {
      const rect = el?.getBoundingClientRect?.()
      if (!rect) return null
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
      }
    }
    const part = (p) =>
      p
        ? {
            index: p.index,
            href: p.href,
            cfi: p.cfi,
            page: p.displayed?.page,
            total: p.displayed?.total,
            slot: p.displayed?.slot,
          }
        : null
    const loc = (location) =>
      location
        ? {
            start: part(location.start),
            end: part(location.end),
            atStart: !!location.atStart,
            atEnd: !!location.atEnd,
          }
        : null
    const panes = Array.from(
      document.querySelectorAll('[data-flow-reader-pane]'),
    ).map((pane, index) => {
      const style = getComputedStyle(pane)
      const frames = Array.from(pane.querySelectorAll('iframe')).map(
        (iframe, frameIndex) => {
          let text = ''
          try {
            text = iframe.contentDocument?.body?.innerText || ''
          } catch {}
          const frameStyle = getComputedStyle(iframe)
          return {
            frameIndex,
            rect: rectOf(iframe),
            visibility: frameStyle.visibility,
            opacity: frameStyle.opacity,
            textPrefix: normalize(text).slice(0, 240),
            textHash: hash(text),
            textLength: normalize(text).length,
          }
        },
      )

      return {
        index,
        hidden: pane.getAttribute('aria-hidden') === 'true',
        rect: rectOf(pane),
        className: pane.className,
        opacity: style.opacity,
        visibility: style.visibility,
        display: style.display,
        pointerEvents: style.pointerEvents,
        text: normalize(pane.innerText),
        frames,
      }
    })
    const group = window.reader?.focusedGroup
    const tabs = (group?.tabs || []).map((tab, index) => {
      const snapshot = tab.paginationSnapshot
      const spread = tab.rendition?.manager?.currentReflowableSpread
      const pane = panes[index]
      return {
        index,
        id: tab.id,
        title: tab.title,
        active: !!tab.active,
        rendered: !!tab.rendered,
        turning: !!tab.turning,
        layoutVersion: tab.layoutVersion,
        paginationVersion: tab.paginationVersion,
        visibleSectionIndexes: [...(tab.visibleSectionIndexes || [])],
        currentLocation: loc(tab.currentLocation),
        bookCfi: tab.book?.cfi,
        pagination: snapshot
          ? {
              location: loc(snapshot.location),
              percentage: snapshot.percentage,
              spreadDivisor: snapshot.spreadDivisor,
              layoutVersion: snapshot.layoutVersion,
              paginationVersion: snapshot.paginationVersion,
              headerPath: snapshot.headerPath?.map((item) => item.label) || [],
              visibleSectionIndexes: [
                ...(snapshot.visibleSectionIndexes || []),
              ],
            }
          : null,
        managerSpread: spread
          ? {
              left: spread.left
                ? {
                    sectionIndex: spread.left.section?.index,
                    pageIndex: spread.left.pageIndex,
                    totalPages: spread.left.totalPages,
                  }
                : null,
              right: spread.right
                ? {
                    sectionIndex: spread.right.section?.index,
                    pageIndex: spread.right.pageIndex,
                    totalPages: spread.right.totalPages,
                  }
                : null,
            }
          : null,
        pane: pane
          ? {
              hidden: pane.hidden,
              opacity: pane.opacity,
              visibility: pane.visibility,
              frameHashes: pane.frames.map((frame) => frame.textHash),
              framePrefixes: pane.frames.map((frame) => frame.textPrefix),
              frameCount: pane.frames.length,
            }
          : null,
      }
    })
    const activePane = panes.find((pane) => !pane.hidden)
    const selectedIndex = group?.selectedIndex ?? -1
    const activeTab = tabs[selectedIndex]
    const sidebar = document.querySelector('.SideBar')
    const sidebarRect = rectOf(sidebar)
    const sidebarStyle = sidebar ? getComputedStyle(sidebar) : null
    const tabRects = Array.from(document.querySelectorAll('[role="tab"]')).map(
      (tab, index) => ({
        index,
        label: tab.getAttribute('aria-label') || normalize(tab.textContent),
        rect: rectOf(tab),
      }),
    )
    return {
      selectedIndex,
      tabCount: tabs.length,
      innerSize: { width: window.innerWidth, height: window.innerHeight },
      sidebarVisible:
        !!sidebar &&
        sidebarStyle.display !== 'none' &&
        sidebarStyle.visibility !== 'hidden' &&
        sidebarRect.width > 10 &&
        sidebarRect.height > 10,
      sidebarRect,
      tabs,
      panes,
      activeTab,
      activePane,
      activePaneText: activePane?.text || '',
      activeFrameCount: activePane?.frames.length || 0,
      activeFrameText: (activePane?.frames || [])
        .map((frame) => frame.textPrefix)
        .join('\n'),
      tabRects,
    }
  })
}

function tabPositionSignature(tab) {
  return JSON.stringify({
    id: tab.id,
    title: tab.title,
    currentLocation: tab.currentLocation,
    bookCfi: tab.bookCfi,
    pagination: tab.pagination
      ? {
          location: tab.pagination.location,
          percentage: tab.pagination.percentage,
          spreadDivisor: tab.pagination.spreadDivisor,
          headerPath: tab.pagination.headerPath,
          visibleSectionIndexes: tab.pagination.visibleSectionIndexes,
        }
      : null,
    managerSpread: tab.managerSpread,
    pane: tab.pane
      ? {
          frameHashes: tab.pane.frameHashes,
          framePrefixes: tab.pane.framePrefixes,
          frameCount: tab.pane.frameCount,
        }
      : null,
  })
}

function activeRenderSignature(state) {
  const tab = state.activeTab
  return JSON.stringify({
    selectedIndex: state.selectedIndex,
    title: tab?.title,
    layoutSize: state.activePane?.rect,
    sidebarVisible: state.sidebarVisible,
    headerPath: tab?.pagination?.headerPath,
    location: tab?.pagination?.location,
    percentage: tab?.pagination?.percentage,
    spreadDivisor: tab?.pagination?.spreadDivisor,
    visibleSectionIndexes: tab?.pagination?.visibleSectionIndexes,
    paneText: state.activePaneText,
    frameHashes: state.activePane?.frames.map((frame) => frame.textHash),
    framePrefixes: state.activePane?.frames.map((frame) => frame.textPrefix),
  })
}

function assertRenderAligned(state, label) {
  assert(state.tabCount > 0, `${label}: no tabs`)
  assert(state.activeTab, `${label}: no active tab`)
  assert(state.activePane, `${label}: no active pane`)
  assert(
    state.activePane.opacity === '1' &&
      state.activePane.visibility === 'visible',
    `${label}: active pane is not visible`,
    state.activePane,
  )
  const paintableHidden = state.panes.filter(
    (pane) =>
      pane.hidden && (pane.opacity !== '0' || pane.visibility !== 'hidden'),
  )
  assert(
    paintableHidden.length === 0,
    `${label}: hidden pane can still paint`,
    paintableHidden,
  )
  assert(state.activeFrameCount > 0, `${label}: no active iframe body`)
  assert(
    state.activeFrameCount <= 2,
    `${label}: active spread has more than two frames`,
    state.activePane.frames,
  )
  assert(
    state.activePane.frames.every((frame) => frame.textLength > 0),
    `${label}: blank iframe body`,
    state.activePane.frames,
  )
  const pagination = state.activeTab.pagination
  assert(pagination, `${label}: missing pagination snapshot`, state.activeTab)
  assert(
    JSON.stringify(pagination.visibleSectionIndexes) ===
      JSON.stringify(state.activeTab.visibleSectionIndexes),
    `${label}: snapshot visible sections diverge from tab visible sections`,
    { pagination, visible: state.activeTab.visibleSectionIndexes },
  )
  const headers = pagination.headerPath.filter(Boolean)
  assert(headers.length > 0, `${label}: empty header path`, pagination)
  const headerMatchesBody =
    headers.some((header) => state.activeFrameText.includes(header)) ||
    state.activeFrameText.includes(state.activeTab.title)
  assert(headerMatchesBody, `${label}: header does not match active body`, {
    headers,
    bodyText: state.activeFrameText,
  })
  const displayed = [
    pagination.location?.start,
    pagination.location?.end,
  ].filter(Boolean)
  assert(
    displayed.some((part) =>
      state.activePaneText.includes(`${part.page} · ${part.total}`),
    ),
    `${label}: footer page text does not match pagination snapshot`,
    { paneText: state.activePaneText, displayed },
  )
  if (typeof pagination.percentage === 'number') {
    const percent = `${(pagination.percentage * 100).toFixed(2)}%`
    assert(
      state.activePaneText.includes(percent),
      `${label}: footer percentage does not match pagination snapshot`,
      { percent, paneText: state.activePaneText },
    )
  }
}

async function waitForSettled(page, label, timeout = 30000) {
  const start = Date.now()
  let last = ''
  let stable = 0
  let lastState
  while (Date.now() - start < timeout) {
    const state = await readState(page)
    lastState = state
    try {
      assertRenderAligned(state, label)
    } catch {
      await wait(250)
      continue
    }
    const signature = activeRenderSignature(state)
    stable = signature === last && !state.activeTab.turning ? stable + 1 : 0
    last = signature
    if (stable >= 2) return state
    await wait(250)
  }
  fail(`${label}: did not settle`, lastState)
}

async function waitForAllTabsReady(page, label, timeout = 30000) {
  const start = Date.now()
  let last = ''
  let stable = 0
  let lastState
  while (Date.now() - start < timeout) {
    const state = await readState(page)
    lastState = state
    const allReady =
      state.tabs.length > 0 &&
      state.tabs.every(
        (tab) => tab.pagination && tab.pane?.frameCount > 0 && !tab.turning,
      )
    if (allReady) {
      const signature = state.tabs.map(tabPositionSignature).join('|')
      stable = signature === last ? stable + 1 : 0
      last = signature
      if (stable >= 2) return state
    }
    await wait(250)
  }
  fail(`${label}: all tabs did not become ready`, lastState)
}

async function instrumentCounters(page) {
  await page.evaluate(() => {
    window.__flowCounterStore = { counters: {}, wrapped: new WeakSet() }
    const methods = [
      'display',
      'next',
      'prev',
      'resizeRendition',
      'relayoutCurrentView',
    ]
    window.__flowWrapTabCounters = () => {
      const store = window.__flowCounterStore
      ;(window.reader?.focusedGroup?.tabs || []).forEach((tab) => {
        if (store.wrapped.has(tab)) return
        store.wrapped.add(tab)
        store.counters[tab.id] ||= { title: tab.title }
        methods.forEach((method) => {
          if (typeof tab[method] !== 'function') return
          const original = tab[method].bind(tab)
          tab[method] = (...args) => {
            store.counters[tab.id][method] =
              (store.counters[tab.id][method] || 0) + 1
            return original(...args)
          }
        })
      })
    }
    window.__flowWrapTabCounters()
    window.__flowResetCounters = () => {
      window.__flowWrapTabCounters()
      Object.values(window.__flowCounterStore.counters).forEach((counter) => {
        methods.forEach((method) => {
          counter[method] = 0
        })
      })
    }
    window.__flowReadCounters = () =>
      structuredClone(window.__flowCounterStore.counters)
  })
}

async function resetCounters(page) {
  await page.evaluate(() => window.__flowResetCounters?.())
}

async function readCounters(page) {
  return page.evaluate(() => window.__flowReadCounters?.() || {})
}

function sumCounters(counters) {
  const sums = {
    display: 0,
    next: 0,
    prev: 0,
    resizeRendition: 0,
    relayoutCurrentView: 0,
  }
  Object.values(counters).forEach((counter) => {
    Object.keys(sums).forEach((method) => {
      sums[method] += counter[method] || 0
    })
  })
  return sums
}

async function injectFrameMarkers(page) {
  await page.evaluate(() => {
    const colors = ['#ff0000', '#0077ff', '#00aa33']
    const labels = ['TAB-A-RED', 'TAB-B-BLUE', 'TAB-C-GREEN']
    Array.from(document.querySelectorAll('[data-flow-reader-pane]')).forEach(
      (pane, paneIndex) => {
        let paneBadge = pane.querySelector(':scope > .__flow_visual_marker')
        if (!paneBadge) {
          paneBadge = document.createElement('div')
          paneBadge.className = '__flow_visual_marker'
          pane.appendChild(paneBadge)
        }
        Object.assign(paneBadge.style, {
          position: 'absolute',
          left: '12px',
          top: '36px',
          zIndex: '2147483647',
          padding: '8px 12px',
          font: '700 28px sans-serif',
          color: colors[paneIndex] || '#111111',
          background: '#ffffff',
          border: `6px solid ${colors[paneIndex] || '#111111'}`,
          pointerEvents: 'none',
        })
        paneBadge.textContent = labels[paneIndex] || `TAB-${paneIndex}`

        pane.querySelectorAll('iframe').forEach((iframe, frameIndex) => {
          try {
            const doc = iframe.contentDocument
            if (!doc?.body) return
            let badge = doc.getElementById('__flow_visual_marker')
            if (!badge) {
              badge = doc.createElement('div')
              badge.id = '__flow_visual_marker'
              doc.body.appendChild(badge)
            }
            Object.assign(badge.style, {
              position: 'fixed',
              left: '12px',
              top: '12px',
              zIndex: '2147483647',
              padding: '8px 12px',
              font: '700 28px sans-serif',
              color: colors[paneIndex] || '#111111',
              background: '#ffffff',
              border: `6px solid ${colors[paneIndex] || '#111111'}`,
              pointerEvents: 'none',
            })
            badge.textContent = `${
              labels[paneIndex] || `TAB-${paneIndex}`
            } F${frameIndex}`
          } catch {}
        })
      },
    )
  })
}

async function markerCounts(page, file) {
  await injectFrameMarkers(page)
  await wait(150)
  const buffer = await page.screenshot({ path: file, fullPage: false })
  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`
  return page.evaluate(async (src) => {
    const image = new Image()
    image.src = src
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data
    const counts = { red: 0, blue: 0, green: 0 }
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      if (r > 210 && g < 80 && b < 80) counts.red += 1
      if (r < 80 && g < 145 && b > 210) counts.blue += 1
      if (r < 80 && g > 150 && b < 100) counts.green += 1
    }
    return counts
  }, dataUrl)
}

function assertOnlyMarker(counts, selectedIndex, label) {
  const channels = ['red', 'blue', 'green']
  channels.forEach((name, index) => {
    if (index === selectedIndex) {
      assert(counts[name] > 20, `${label}: selected marker missing`, counts)
    } else {
      assert(counts[name] === 0, `${label}: hidden marker leaked`, counts)
    }
  })
}

async function navigateTabTo(page, tabIndex, sectionIndex, nextCount = 0) {
  await page.evaluate(
    async ({ tabIndex, sectionIndex, nextCount }) => {
      const group = window.reader.focusedGroup
      group.selectTab(tabIndex)
      const tab = group.tabs[tabIndex]
      const deadline = Date.now() + 30000
      while (
        (!tab.sections || !tab.sections[sectionIndex]) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const section = tab.sections?.[sectionIndex]
      if (!section) throw new Error(`section ${sectionIndex} missing`)
      await tab.displaySectionStart(section)
      for (let i = 0; i < nextCount; i += 1) await tab.next()
    },
    { tabIndex, sectionIndex, nextCount },
  )
  await waitForSettled(page, `navigate tab ${tabIndex} section ${sectionIndex}`)
}

async function navigateTabToEnd(page, tabIndex) {
  await page.evaluate(
    async ({ tabIndex }) => {
      const group = window.reader.focusedGroup
      group.selectTab(tabIndex)
      const tab = group.tabs[tabIndex]
      const deadline = Date.now() + 30000
      while ((!tab.sections || !tab.sections.length) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const section = tab.sections?.[tab.sections.length - 1]
      if (!section) throw new Error('last section missing')
      await tab.displaySectionStart(section)
      for (let i = 0; i < 40 && !tab.currentLocation?.atEnd; i += 1) {
        await tab.next()
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    },
    { tabIndex },
  )
  const state = await waitForSettled(page, `navigate tab ${tabIndex} end`)
  assert(
    state.activeTab.currentLocation?.atEnd ||
      state.activeTab.pagination?.location?.atEnd,
    'tab did not reach final page',
    state.activeTab,
  )
}

async function switchByKeyboard(page, targetIndex, label, options = {}) {
  const { pure = true } = options
  await resetCounters(page)
  const beforeRects = (await readState(page)).tabRects
  await page.keyboard.press(`Control+Digit${targetIndex + 1}`)
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
  )
  const immediate = await readState(page)
  const counters = await readCounters(page)
  const sums = sumCounters(counters)
  assert(immediate.selectedIndex === targetIndex, `${label}: not immediate`, {
    selectedIndex: immediate.selectedIndex,
    targetIndex,
  })
  if (pure) {
    assert(
      Object.values(sums).every((value) => value === 0),
      `${label}: pure tab switch called pagination operation`,
      { sums, counters },
    )
  }
  beforeRects.forEach((before, i) => {
    const after = immediate.tabRects[i]
    assert(
      after && JSON.stringify(before.rect) === JSON.stringify(after.rect),
      `${label}: tab-strip geometry moved`,
      { before, after },
    )
  })
  return waitForSettled(page, label)
}

async function switchByTabWheel(page, delta, expectedIndex, label) {
  await resetCounters(page)
  const before = await readState(page)
  const firstTab = before.tabRects[0]?.rect
  assert(firstTab, `${label}: no tab rect`)
  await page.mouse.move(firstTab.x + 30, firstTab.y + 10)
  await page.mouse.wheel(0, delta)
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
  )
  const immediate = await readState(page)
  const counters = await readCounters(page)
  const sums = sumCounters(counters)
  assert(immediate.selectedIndex === expectedIndex, `${label}: not immediate`, {
    selectedIndex: immediate.selectedIndex,
    expectedIndex,
  })
  assert(
    Object.values(sums).every((value) => value === 0),
    `${label}: wheel tab switch called pagination operation`,
    { sums, counters },
  )
  before.tabRects.forEach((beforeRect, i) => {
    const after = immediate.tabRects[i]
    assert(
      after && JSON.stringify(beforeRect.rect) === JSON.stringify(after.rect),
      `${label}: tab-strip geometry moved`,
      { before: beforeRect, after },
    )
  })
  return waitForSettled(page, label)
}

async function activeIframeCenter(page) {
  return page.evaluate(() => {
    const frame = document.querySelector(
      '[data-flow-reader-pane][aria-hidden="false"] iframe',
    )
    const rect = frame?.getBoundingClientRect()
    return rect
      ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      : null
  })
}

async function assertHiddenTabsUnchanged(page, operation, label) {
  const before = await waitForAllTabsReady(page, `${label} before`)
  const activeIndex = before.selectedIndex
  const beforeHidden = new Map(
    before.tabs
      .filter((tab) => tab.index !== activeIndex)
      .map((tab) => [tab.id, tabPositionSignature(tab)]),
  )
  await operation()
  await waitForSettled(page, label)
  const after = await waitForAllTabsReady(page, `${label} after`)
  after.tabs
    .filter((tab) => tab.index !== after.selectedIndex)
    .forEach((tab) => {
      const previous = beforeHidden.get(tab.id)
      if (!previous) return
      assert(
        tabPositionSignature(tab) === previous,
        `${label}: hidden tab changed`,
        {
          before: previous,
          after: tabPositionSignature(tab),
          tab,
        },
      )
    })
}

async function main() {
  const outDir = path.join(os.tmpdir(), `flow-tauri-md4-${Date.now()}`)
  const booksDir = path.join(outDir, 'books')
  fs.mkdirSync(booksDir, { recursive: true })
  const bookA = path.join(booksDir, 'FLOW_MD4_A_RED.txt')
  const bookB = path.join(booksDir, 'FLOW_MD4_B_BLUE.txt')
  const bookC = path.join(booksDir, 'FLOW_MD4_C_GREEN.txt')
  makeBook(bookA, 'FLOW_MD4_A_RED', 'MD4_A_RED', 90, 14)
  makeBook(bookB, 'FLOW_MD4_B_BLUE', 'MD4_B_BLUE', 90, 14)
  makeBook(bookC, 'FLOW_MD4_C_GREEN', 'MD4_C_GREEN', 90, 8)

  const browser = await chromium.connectOverCDP(CDP_URL)
  const page =
    browser
      .contexts()[0]
      .pages()
      .find((candidate) => candidate.url().includes('localhost:7127')) ||
    browser.contexts()[0].pages()[0]
  page.on('pageerror', (error) => console.log('PAGEERROR', error.message))

  setFlowWindowBounds(1600, 1000)
  await wait(1000)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(
    () => Boolean(window.__TAURI_INTERNALS__?.invoke && window.reader),
    null,
    { timeout: 30000 },
  )

  const imported = await invoke(page, 'import_text_paths', {
    imports: [{ path: bookA }, { path: bookB }, { path: bookC }],
    replaceExisting: true,
  })
  await page.evaluate((books) => {
    window.reader.closeAllTabs?.()
    books.forEach((book) => window.reader.addTab(book))
  }, imported)
  await ensureReaderMode(page)
  await waitForSettled(page, 'initial imported tabs')
  await instrumentCounters(page)

  await ensureSidebar(page, true)
  await navigateTabTo(page, 0, 8, 2)
  await navigateTabTo(page, 1, 35, 3)
  await navigateTabToEnd(page, 2)
  await page.evaluate(() => window.reader.focusedGroup.selectTab(0))
  await waitForSettled(page, 'tab A active before standards')
  await waitForAllTabsReady(page, 'all tabs positioned')

  const results = []

  let state = await switchByKeyboard(page, 1, 'standard 1 keyboard A->B')
  let counts = await markerCounts(
    page,
    path.join(outDir, 'standard1-keyboard-B.png'),
  )
  assertOnlyMarker(counts, 1, 'standard 1 keyboard visual')
  assertRenderAligned(state, 'standard 1 keyboard settled')
  state = await switchByKeyboard(page, 0, 'standard 1 keyboard B->A')
  counts = await markerCounts(
    page,
    path.join(outDir, 'standard1-keyboard-A.png'),
  )
  assertOnlyMarker(counts, 0, 'standard 1 keyboard visual back')
  await switchByTabWheel(page, 90, 1, 'standard 1 tab wheel A->B')
  counts = await markerCounts(page, path.join(outDir, 'standard1-wheel-B.png'))
  assertOnlyMarker(counts, 1, 'standard 1 wheel visual')
  await switchByTabWheel(page, -90, 0, 'standard 1 tab wheel B->A')
  counts = await markerCounts(page, path.join(outDir, 'standard1-wheel-A.png'))
  assertOnlyMarker(counts, 0, 'standard 1 wheel visual back')
  results.push('standard 1 passed')

  await page.evaluate(() => window.reader.focusedGroup.selectTab(0))
  await waitForSettled(page, 'hidden unchanged setup')
  await assertHiddenTabsUnchanged(
    page,
    async () => {
      await page.keyboard.press('ArrowRight')
    },
    'hidden tabs after active ArrowRight',
  )
  await wait(250)
  await assertHiddenTabsUnchanged(
    page,
    async () => {
      const point = await activeIframeCenter(page)
      assert(point, 'active iframe center missing')
      await page.mouse.move(point.x, point.y)
      await page.mouse.wheel(0, 120)
    },
    'hidden tabs after active content wheel',
  )
  results.push('hidden tab input isolation passed')

  await page.evaluate(() => {
    const group = window.reader.focusedGroup
    while (group.tabs.length > 1) window.reader.removeTab(group.tabs.length - 1)
    group.selectTab(0)
  })
  await ensureSidebar(page, true)
  await navigateTabTo(page, 0, 22, 2)
  const open1 = activeRenderSignature(
    await waitForSettled(page, 'standard 2 sidebar open first'),
  )
  await ensureSidebar(page, false)
  await waitForSettled(page, 'standard 2 sidebar closed')
  await ensureSidebar(page, true)
  const open2 = activeRenderSignature(
    await waitForSettled(page, 'standard 2 sidebar open second'),
  )
  assert(
    open1 === open2,
    'standard 2 sidebar open state did not reproduce exactly',
    {
      open1,
      open2,
    },
  )

  setFlowWindowBounds(1500, 940)
  const restored1 = activeRenderSignature(
    await waitForSettled(page, 'standard 2 restored first'),
  )
  maximizeFlowWindow()
  await waitForSettled(page, 'standard 2 maximized')
  setFlowWindowBounds(1500, 940)
  const restored2 = activeRenderSignature(
    await waitForSettled(page, 'standard 2 restored second'),
  )
  assert(
    restored1 === restored2,
    'standard 2 restored state did not reproduce exactly',
    {
      restored1,
      restored2,
    },
  )
  results.push('standard 2 passed')

  const singleOps = [
    async () => setFlowWindowBounds(1420, 920),
    async () => ensureSidebar(page, false),
    async () => setFlowWindowBounds(1780, 1040),
    async () => ensureSidebar(page, true),
    async () => maximizeFlowWindow(),
    async () => setFlowWindowBounds(1600, 1000),
    async () => ensureSidebar(page, false),
    async () => setFlowWindowBounds(1500, 940),
    async () => ensureSidebar(page, true),
  ]
  for (let i = 0; i < singleOps.length; i += 1) {
    await singleOps[i]()
    assertRenderAligned(
      await waitForSettled(page, `standard 3 op ${i}`),
      `standard 3 op ${i}`,
    )
  }
  results.push('standard 3 passed')

  await page.evaluate((books) => {
    window.reader.closeAllTabs?.()
    books.forEach((book) => window.reader.addTab(book))
  }, imported)
  await ensureReaderMode(page)
  await ensureSidebar(page, true)
  setFlowWindowBounds(1600, 1000)
  await navigateTabTo(page, 0, 18, 2)
  await navigateTabTo(page, 1, 46, 1)
  await navigateTabToEnd(page, 2)
  await page.evaluate(() => window.reader.focusedGroup.selectTab(0))
  const tab0OpenBefore = activeRenderSignature(
    await waitForSettled(page, 'standard 4 tab0 open before'),
  )
  await waitForAllTabsReady(page, 'standard 4 positioned')

  await switchByKeyboard(page, 1, 'standard 4 tab0->tab1')
  await ensureSidebar(page, false)
  setFlowWindowBounds(1450, 900)
  assertRenderAligned(
    await waitForSettled(page, 'standard 4 tab1 closed resized'),
    'standard 4 tab1 closed resized',
  )
  await switchByKeyboard(page, 2, 'standard 4 tab1->tab2', { pure: false })
  maximizeFlowWindow()
  assertRenderAligned(
    await waitForSettled(page, 'standard 4 tab2 maximized'),
    'standard 4 tab2 maximized',
  )
  await ensureSidebar(page, true)
  assertRenderAligned(
    await waitForSettled(page, 'standard 4 tab2 open maximized'),
    'standard 4 tab2 open maximized',
  )
  setFlowWindowBounds(1600, 1000)
  await switchByKeyboard(page, 0, 'standard 4 switch back tab0')
  await ensureSidebar(page, true)
  const tab0OpenAfter = activeRenderSignature(
    await waitForSettled(page, 'standard 4 tab0 open after'),
  )
  assert(
    tab0OpenBefore === tab0OpenAfter,
    'standard 4 tab0 same open layout did not reproduce exactly',
    { before: tab0OpenBefore, after: tab0OpenAfter },
  )
  counts = await markerCounts(
    page,
    path.join(outDir, 'standard4-tab0-return.png'),
  )
  assertOnlyMarker(counts, 0, 'standard 4 tab0 return visual')
  results.push('standard 4 passed')

  const finalState = await readState(page)
  console.log(
    JSON.stringify(
      {
        outDir,
        results,
        finalSelectedIndex: finalState.selectedIndex,
        finalInnerSize: finalState.innerSize,
      },
      null,
      2,
    ),
  )
  await browser.close()
}

main().catch((error) => {
  console.error(error.message)
  if (error.detail) {
    console.error(JSON.stringify(error.detail, null, 2).slice(0, 8000))
  }
  process.exit(1)
})
