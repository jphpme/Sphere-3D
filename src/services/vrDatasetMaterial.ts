import type * as THREE from 'three'

export interface VrDatasetTextureSource {
  readonly texture: THREE.Texture
  readonly width: number
  readonly height: number
  readonly baseColor?: number
  readonly baseOpacity?: number
}

export function configureVrDatasetTexture(
  THREE_: typeof THREE,
  texture: THREE.Texture,
): void {
  texture.colorSpace = THREE_.SRGBColorSpace
  texture.minFilter = THREE_.LinearFilter
  texture.magFilter = THREE_.LinearFilter
  texture.generateMipmaps = false
}

export function getVrDatasetTextureSize(source: HTMLVideoElement | HTMLImageElement): { width: number; height: number } {
  if (source instanceof HTMLVideoElement) {
    return {
      width: Math.max(1, source.videoWidth || source.clientWidth || 1),
      height: Math.max(1, source.videoHeight || source.clientHeight || 1),
    }
  }

  return {
    width: Math.max(1, source.naturalWidth || source.width || 1),
    height: Math.max(1, source.naturalHeight || source.height || 1),
  }
}

/**
 * Dataset material for WebXR/Three.js globes.
 *
 * Transparent VP9/DASH frames are straight-alpha media. Regular GPU
 * bilinear filtering blends RGB before alpha compositing, so white RGB in
 * transparent neighbor texels leaks into sparse data edges. This shader does
 * the same fix as the MapLibre custom layer: sample four texels, premultiply
 * each texel first, then bilinearly interpolate in premultiplied space.
 */
export function createVrDatasetMaterial(
  THREE_: typeof THREE,
  source: VrDatasetTextureSource,
): THREE.ShaderMaterial {
  const baseOpacity = Math.max(0, Math.min(1, source.baseOpacity ?? 0))
  const opaqueBase = baseOpacity >= 0.999

  return new THREE_.ShaderMaterial({
    uniforms: {
      uMap: { value: source.texture },
      uTexSize: { value: new THREE_.Vector2(source.width, source.height) },
      uBaseColor: { value: new THREE_.Color(source.baseColor ?? 0x000000) },
      uBaseOpacity: { value: baseOpacity },
    },
    vertexShader: `
      varying vec2 vUv;

      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;

      uniform sampler2D uMap;
      uniform vec2 uTexSize;
      uniform vec3 uBaseColor;
      uniform float uBaseOpacity;
      varying vec2 vUv;

      vec4 premultiply(vec4 c) {
        c.a = clamp(c.a, 0.0, 1.0);
        c.rgb *= c.a;
        return c;
      }

      vec4 readDatasetTexel(vec2 pixel) {
        vec2 maxPixel = max(uTexSize - vec2(1.0), vec2(0.0));
        vec2 clamped = clamp(pixel, vec2(0.0), maxPixel);
        return texture2D(uMap, (clamped + vec2(0.5)) / uTexSize);
      }

      vec4 samplePremultipliedBilinear(vec2 uv) {
        vec2 pixel = uv * uTexSize - vec2(0.5);
        vec2 base = floor(pixel);
        vec2 f = fract(pixel);

        vec4 c00 = premultiply(readDatasetTexel(base));
        vec4 c10 = premultiply(readDatasetTexel(base + vec2(1.0, 0.0)));
        vec4 c01 = premultiply(readDatasetTexel(base + vec2(0.0, 1.0)));
        vec4 c11 = premultiply(readDatasetTexel(base + vec2(1.0, 1.0)));

        return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
      }

      void main() {
        vec4 color = samplePremultipliedBilinear(vUv);
        vec4 base = vec4(uBaseColor * uBaseOpacity, uBaseOpacity);
        vec4 composed = color + base * (1.0 - color.a);
        if (composed.a < 0.003) discard;
        gl_FragColor = composed;
      }
    `,
    transparent: !opaqueBase,
    depthWrite: opaqueBase,
    depthTest: true,
    blending: opaqueBase ? THREE_.NoBlending : THREE_.CustomBlending,
    blendEquation: THREE_.AddEquation,
    blendSrc: THREE_.OneFactor,
    blendDst: THREE_.OneMinusSrcAlphaFactor,
    premultipliedAlpha: true,
    side: THREE_.DoubleSide,
  })
}
