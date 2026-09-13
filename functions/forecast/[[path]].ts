// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { proxyRealtimeAsset } from '../_realtimeAssetProxy'

export const onRequest: PagesFunction = (context) => {
  return proxyRealtimeAsset(context, 'forecast')
}
