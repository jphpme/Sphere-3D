import { describe, expect, it, vi } from 'vitest'
import { renderToursPage } from './tours'

describe('renderToursPage (tour/A + /E)', () => {
  it('renders the empty-state shell with a New tour button', () => {
    const content = document.createElement('div')
    renderToursPage(content, {
      navigate: () => {},
      createDraft: vi.fn(),
    })
    expect(content.querySelector('h2')?.textContent).toBe('Tours')
    const btn = content.querySelector<HTMLButtonElement>(
      'button[aria-label="Start a new tour"]',
    )
    expect(btn).toBeTruthy()
    expect(content.querySelector('.publisher-empty')?.textContent).toContain('No tours yet')
  })

  it('POSTs /publish/tours/draft and navigates to /?tourEdit=<new-id> on success', async () => {
    // Phase 3pt/E — the New tour button now creates a backend
    // draft before navigating, so the URL carries a real ULID
    // instead of the `?tourEdit=new` sentinel.
    const content = document.createElement('div')
    const navigate = vi.fn()
    const createDraft = vi.fn(async () => ({
      tour: {
        id: '01HXAAAAAAAAAAAAAAAAAAAAAA',
        slug: 'untitled-tour-aaaaaa',
        title: 'Untitled tour AAAAAA',
        tour_json_ref: 'r2:tours/01HXAAAAAAAAAAAAAAAAAAAAAA/draft.json',
        updated_at: '2026-05-21T20:30:00.000Z',
      },
    }))
    renderToursPage(content, { navigate, createDraft })
    content
      .querySelector<HTMLButtonElement>('button[aria-label="Start a new tour"]')!
      .click()
    // Pump microtasks for the async chain.
    await Promise.resolve()
    await Promise.resolve()
    expect(createDraft).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith(
      '/?tourEdit=01HXAAAAAAAAAAAAAAAAAAAAAA',
    )
  })

  it('surfaces a draft-creation error inline and re-enables the button', async () => {
    const content = document.createElement('div')
    const navigate = vi.fn()
    const createDraft = vi.fn(async () => ({ error: 'Network unavailable' }))
    renderToursPage(content, { navigate, createDraft })
    const btn = content.querySelector<HTMLButtonElement>(
      'button[aria-label="Start a new tour"]',
    )!
    btn.click()
    await Promise.resolve()
    await Promise.resolve()
    expect(navigate).not.toHaveBeenCalled()
    expect(btn.disabled).toBe(false)
    expect(content.querySelector('.publisher-tour-new-error')?.textContent).toContain(
      'Network unavailable',
    )
  })

  it('clears prior content (idempotent re-render)', () => {
    const content = document.createElement('div')
    content.innerHTML = '<div class="stale">stale</div>'
    renderToursPage(content, { navigate: () => {}, createDraft: vi.fn() })
    expect(content.querySelector('.stale')).toBeNull()
    expect(content.querySelector('.publisher-shell')).toBeTruthy()
  })
})
