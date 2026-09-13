// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { proxyRealtimeDashAsset } from '../_realtimeAssetProxy'

export const onRequest: PagesFunction = (context) => {
  return proxyRealtimeDashAsset(context)
}
