import { proxyRealtimeAsset } from '../_realtimeAssetProxy'

export const onRequest: PagesFunction = (context) => {
  return proxyRealtimeAsset(context, 'realtime')
}
