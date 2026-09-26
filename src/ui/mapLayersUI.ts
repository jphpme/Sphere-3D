// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — the layer picker: a "Layers" section in the Tools menu to choose
 * the basemap under the dataset, the overlays above it, and the colour the
 * overlays' lines are drawn in. It renders into the empty
 * `#tools-menu-layers` section toolsMenuUI leaves for it, and re-renders
 * whenever main.ts hands it a new catalog or selection — including the
 * defaults a newly loaded dataset starts with. The section stays hidden
 * while the catalog has no layers.
 */

import { t, tAttr, tHtml, type MessageKey } from '../i18n'
import { escapeAttr, escapeHtml } from './domUtils'
import type { CatalogLayer, LayerSelection, MapLayerTint } from '../services/mapLayers'

export interface LayerPickerHandle {
  /** Re-render for a catalog and the selection currently applied. */
  update(catalog: readonly CatalogLayer[], selection: LayerSelection): void
}

const TINTS: readonly MapLayerTint[] = ['white', 'black', 'source']
const TINT_LABEL: Record<MapLayerTint, MessageKey> = {
  white: 'tools.layers.tint.white',
  black: 'tools.layers.tint.black',
  source: 'tools.layers.tint.source',
}

/** The tint the picker shows: the overlays' shared one, white by default. */
function currentTint(selection: LayerSelection): MapLayerTint {
  return selection.overlays[0]?.tint ?? 'white'
}

export function mountLayerPicker(onChange: (selection: LayerSelection) => void): LayerPickerHandle {
  let catalog: readonly CatalogLayer[] = []
  let selection: LayerSelection = { basemapId: null, overlays: [] }

  function render(): void {
    const host = document.getElementById('tools-menu-layers')
    if (!host) return
    host.hidden = catalog.length === 0
    if (host.hidden) {
      host.innerHTML = ''
      return
    }
    const basemaps = catalog.filter(l => l.kind === 'basemap')
    const overlays = catalog.filter(l => l.kind === 'overlay')
    const on = new Set(selection.overlays.map(o => o.id))
    const tint = currentTint(selection)
    host.setAttribute('aria-label', t('tools.layers.aria'))
    host.innerHTML = `
      <h4 class="tools-menu-section-title">${tHtml('tools.layers.title')}</h4>
      <div class="tools-menu-language-row">
        <label for="tools-menu-layers-basemap" class="tools-menu-layers-label">${tHtml('tools.layers.basemap')}</label>
        <select id="tools-menu-layers-basemap" class="tools-menu-language-select">
          <option value=""${selection.basemapId ? '' : ' selected'}>${tHtml('tools.layers.basemap.none')}</option>
          ${basemaps.map(l => `<option value="${escapeAttr(l.id)}"${l.id === selection.basemapId ? ' selected' : ''}>${escapeHtml(l.title)}</option>`).join('')}
        </select>
      </div>
      <div class="tools-menu-layers-label" id="tools-menu-layers-overlays-label">${tHtml('tools.layers.overlays')}</div>
      <div role="group" aria-labelledby="tools-menu-layers-overlays-label">
        ${overlays.map(l => `
          <button type="button" class="tools-menu-item${on.has(l.id) ? ' active' : ''}" data-layer-id="${escapeAttr(l.id)}" aria-pressed="${on.has(l.id)}">
            <span class="tools-menu-item-check" aria-hidden="true"></span>
            <span class="tools-menu-item-label">${escapeHtml(l.title)}</span>
          </button>`).join('')}
      </div>
      <div class="tools-menu-language-row">
        <label for="tools-menu-layers-tint" class="tools-menu-layers-label">${tHtml('tools.layers.tint')}</label>
        <select id="tools-menu-layers-tint" class="tools-menu-language-select" aria-label="${tAttr('tools.layers.tint')}">
          ${TINTS.map(v => `<option value="${v}"${v === tint ? ' selected' : ''}>${tHtml(TINT_LABEL[v])}</option>`).join('')}
        </select>
      </div>`

    host.querySelector<HTMLSelectElement>('#tools-menu-layers-basemap')?.addEventListener('change', (e) => {
      const id = (e.target as HTMLSelectElement).value
      onChange({ ...selection, basemapId: id || null })
    })
    host.querySelector<HTMLSelectElement>('#tools-menu-layers-tint')?.addEventListener('change', (e) => {
      const next = (e.target as HTMLSelectElement).value as MapLayerTint
      onChange({ ...selection, overlays: selection.overlays.map(o => ({ ...o, tint: next })) })
    })
    host.querySelectorAll<HTMLButtonElement>('[data-layer-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.layerId!
        const overlaysNow = on.has(id)
          ? selection.overlays.filter(o => o.id !== id)
          // Kept in catalog order, so the stack does not depend on click order.
          : overlays.filter(l => on.has(l.id) || l.id === id).map(l => ({ id: l.id, tint }))
        onChange({ ...selection, overlays: overlaysNow })
      })
    })
  }

  return {
    update(nextCatalog, nextSelection) {
      catalog = nextCatalog
      selection = nextSelection
      render()
    },
  }
}
