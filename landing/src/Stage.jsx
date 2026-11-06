import { useEffect, useRef } from 'react';
import { initScene } from './scene.js';

/** Fixed WebGL canvas + 3D-anchored labels. The scene reads the page's [data-station] elements. */
export default function Stage({ heroStageRef }) {
  const canvasRef = useRef(null);
  const labelsRef = useRef(null);

  useEffect(() => {
    let cleanup = () => {};
    try {
      cleanup = initScene({
        canvas: canvasRef.current, heroStage: heroStageRef.current, labelsEl: labelsRef.current,
        onReady: () => document.documentElement.classList.add('webgl-on'),
      });
    } catch (err) {
      console.warn('3D disabled:', err);
    }
    return () => {
      cleanup();
      document.documentElement.classList.remove('webgl-on');
    };
  }, [heroStageRef]);

  return (
    <>
      <canvas id="stage" ref={canvasRef} aria-hidden="true" />
      <div id="labels" ref={labelsRef} aria-hidden="true" />
    </>
  );
}
