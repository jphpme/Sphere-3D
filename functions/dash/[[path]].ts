import { proxyRealtimeDashAsset } from '../_realtimeAssetProxy'

export const onRequest: PagesFunction = (context) => {
  return proxyRealtimeDashAsset(context)
}
