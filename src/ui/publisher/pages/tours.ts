/**
 * `/publish/tours` — landing page for the tour-creator sub-phase
 * set. Phase 3pt/A ships an empty-state card plus a "New tour"
 * button that bounces the user into the SPA's tour-authoring
 * mode (`/?tourEdit=new`). The list of existing tours and per-
 * row Edit / Preview links land in tour/E (alongside autosave
 * and backend persistence — without those, the list would be
 * empty by construction).
 *
 * Visual conventions match `pages/datasets.ts`: `publisher-shell`
 * outer, `publisher-card publisher-glass` for the empty state,
 * `publisher-tab`-style buttons for primary actions.
 */

import { t } from '../../../i18n'
import { createDraftTour } from '../../tourAuthoring/api'

export interface ToursPageOptions {
  /** Host-supplied navigator. Tests stub this. Defaults to
   *  `window.location.assign` so the SPA-mode entry actually
   *  leaves the publisher portal. */
  navigate?: (url: string) => void
  /** Override the POST /draft API call — tests inject a stub. */
  createDraft?: typeof createDraftTour
}

export function renderToursPage(content: HTMLElement, options: ToursPageOptions = {}): void {
  const navigate = options.navigate ?? ((url: string) => {
    window.location.assign(url)
  })
  const createDraft = options.createDraft ?? createDraftTour

  const shell = document.createElement('main')
  shell.className = 'publisher-shell'

  const header = document.createElement('div')
  header.className = 'publisher-tour-list-header'

  const h2 = document.createElement('h2')
  h2.textContent = t('publisher.tours.heading')
  header.appendChild(h2)

  const newBtn = document.createElement('button')
  newBtn.type = 'button'
  newBtn.className = 'publisher-tab publisher-tab-active publisher-tour-new-btn'
  newBtn.setAttribute('aria-label', t('publisher.tours.new.aria'))
  newBtn.textContent = t('publisher.tours.new')
  newBtn.addEventListener('click', () => {
    // Phase 3pt/E — POST /publish/tours/draft mints a fresh
    // row + writes an empty TourFile blob, then we navigate to
    // the SPA with the new id. Disable the button while in-
    // flight so a double-click can't create two drafts.
    newBtn.disabled = true
    newBtn.textContent = t('publisher.tours.new.creating')
    void createDraft().then(result => {
      if ('error' in result) {
        // Re-enable so the user can retry; surface the error
        // inline below the button.
        newBtn.disabled = false
        newBtn.textContent = t('publisher.tours.new')
        let err = newBtn.parentElement?.querySelector(
          '.publisher-tour-new-error',
        ) as HTMLElement | null
        if (!err) {
          err = document.createElement('p')
          err.className = 'publisher-tour-new-error'
          newBtn.parentElement?.appendChild(err)
        }
        err.textContent = result.error
        return
      }
      navigate(`/?tourEdit=${encodeURIComponent(result.tour.id)}`)
    })
  })
  header.appendChild(newBtn)
  shell.appendChild(header)

  const intro = document.createElement('p')
  intro.className = 'publisher-tour-intro'
  intro.textContent = t('publisher.tours.intro')
  shell.appendChild(intro)

  const empty = document.createElement('section')
  empty.className = 'publisher-card publisher-glass publisher-empty'
  const emptyTitle = document.createElement('p')
  emptyTitle.className = 'publisher-empty-message'
  emptyTitle.textContent = t('publisher.tours.empty.title')
  empty.appendChild(emptyTitle)
  const emptyHint = document.createElement('p')
  emptyHint.className = 'publisher-tour-empty-hint'
  emptyHint.textContent = t('publisher.tours.empty.hint')
  empty.appendChild(emptyHint)
  shell.appendChild(empty)

  content.replaceChildren(shell)
}
