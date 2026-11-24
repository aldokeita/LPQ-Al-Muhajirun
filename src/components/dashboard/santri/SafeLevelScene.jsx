import React, { Component, lazy, Suspense } from 'react';

const SantriLevelScene = lazy(() => import('@/components/dashboard/santri/SantriLevelScene'));

let webglSupportCache;

export const isWebGLAvailable = () => {
  if (webglSupportCache !== undefined) return webglSupportCache;
  try {
    if (typeof document === 'undefined' || typeof window === 'undefined' || !window.WebGLRenderingContext) {
      webglSupportCache = false;
      return webglSupportCache;
    }
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    webglSupportCache = Boolean(gl);
    gl?.getExtension?.('WEBGL_lose_context')?.loseContext();
  } catch {
    webglSupportCache = false;
  }
  return webglSupportCache;
};

const StaticSceneBackdrop = ({ accentColor }) => (
  <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true" data-testid="level-scene-fallback">
    <div
      className="absolute inset-0 opacity-50"
      style={{
        background: `radial-gradient(circle at 72% 42%, ${accentColor}42, transparent 44%), radial-gradient(circle at 18% 80%, ${accentColor}22, transparent 35%)`,
      }}
    />
  </div>
);

class SceneErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    if (import.meta.env?.DEV) console.warn('Adegan 3D dinonaktifkan:', error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Adegan konstelasi 3D dengan fallback statis bila WebGL tidak tersedia atau gagal. */
const SafeLevelScene = ({ accentColor = '#0ea5e9', points = 0 }) => {
  const fallback = <StaticSceneBackdrop accentColor={accentColor} />;
  if (!isWebGLAvailable()) return fallback;

  return (
    <SceneErrorBoundary fallback={fallback}>
      <Suspense fallback={null}>
        <SantriLevelScene accentColor={accentColor} points={points} />
      </Suspense>
    </SceneErrorBoundary>
  );
};

export default SafeLevelScene;
