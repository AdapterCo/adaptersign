'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { t } from '@/lib/i18n';
import { Button } from './ui';

const WIDTH = 600;
const HEIGHT = 200;

/** Quadro de assinatura desenhada (mouse, caneta ou toque). Exporta PNG. */
export function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  const ctx = useCallback(() => {
    const c = canvas.current?.getContext('2d');
    if (c) {
      c.lineWidth = 2.5;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.strokeStyle = '#1b2333';
    }
    return c ?? null;
  }, []);

  useEffect(() => {
    const c = ctx();
    if (c) {
      c.fillStyle = 'rgba(0,0,0,0)';
      c.clearRect(0, 0, WIDTH, HEIGHT);
    }
  }, [ctx]);

  function point(e: ReactPointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * WIDTH, y: ((e.clientY - rect.top) / rect.height) * HEIGHT };
  }

  function down(e: ReactPointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const c = ctx();
    const p = point(e);
    c?.beginPath();
    c?.moveTo(p.x, p.y);
  }

  function move(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const c = ctx();
    const p = point(e);
    c?.lineTo(p.x, p.y);
    c?.stroke();
    if (!hasInk) setHasInk(true);
  }

  function up() {
    if (!drawing.current) return;
    drawing.current = false;
    if (canvas.current && hasInk) onChange(canvas.current.toDataURL('image/png'));
  }

  function clear() {
    ctx()?.clearRect(0, 0, WIDTH, HEIGHT);
    setHasInk(false);
    onChange(null);
  }

  return (
    <div>
      <p className="mb-2 text-sm text-muted">{t.sign.drawHere}</p>
      <canvas
        ref={canvas}
        width={WIDTH}
        height={HEIGHT}
        role="img"
        aria-label={t.sign.drawHere}
        className="w-full touch-none rounded-lg border-2 border-dashed border-line bg-white"
        style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
      />
      <div className="mt-2 text-right">
        <Button variant="ghost" onClick={clear} disabled={!hasInk}>
          {t.sign.clear}
        </Button>
      </div>
    </div>
  );
}
