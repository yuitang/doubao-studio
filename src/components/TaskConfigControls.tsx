import React, { useState } from 'react';
import { Slider } from 'antd';
import type { VideoDuration } from '../types';

const MIN_DURATION = 4;
const MAX_DURATION = 15;

/**
 * 视频时长滑杆（4–15 秒，1 秒步进）。
 * 拖动手柄选择时长，并在手柄上方实时显示秒数。
 */
export function DurationSlider({
  value,
  onChange,
  style,
}: {
  value: VideoDuration;
  onChange: (duration: VideoDuration) => void;
  style?: React.CSSProperties;
}): React.ReactElement {
  const seconds = Math.min(
    MAX_DURATION,
    Math.max(MIN_DURATION, Number.parseInt(value, 10) || MIN_DURATION),
  );
  return (
    <div style={{ padding: '0 8px', marginBottom: 16, ...style }}>
      <div style={{ textAlign: 'center', color: '#d9d9f0', fontSize: 13, marginBottom: 2 }}>
        {seconds} 秒
      </div>
      <Slider
        min={MIN_DURATION}
        max={MAX_DURATION}
        step={1}
        value={seconds}
        onChange={(v) => onChange(`${v}s` as VideoDuration)}
        tooltip={{ formatter: (v) => `${v} 秒` }}
        marks={{
          4: '4s',
          8: '8s',
          12: '12s',
          15: '15s',
        }}
      />
    </div>
  );
}

/**
 * 可拖拽排序的参考图片缩略图网格。
 * 按住缩略图拖动到另一张上即可交换顺序（HTML5 原生拖放，无需额外依赖）。
 */
export function DraggableImageGrid({
  items,
  base64Map,
  onReorder,
  onRemove,
  addSlot,
  altPrefix = '参考图片',
}: {
  items: string[];
  base64Map: Record<string, string | undefined>;
  onReorder: (next: string[]) => void;
  onRemove: (filePath: string) => void;
  addSlot: React.ReactNode;
  altPrefix?: string;
}): React.ReactElement {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const handleDrop = (targetIndex: number) => {
    if (dragIndex === null || dragIndex === targetIndex) {
      setDragIndex(null);
      setOverIndex(null);
      return;
    }
    const next = [...items];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(targetIndex, 0, moved);
    onReorder(next);
    setDragIndex(null);
    setOverIndex(null);
  };

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {items.map((filePath, idx) => (
        <div
          key={filePath}
          draggable
          onDragStart={() => setDragIndex(idx)}
          onDragEnd={() => {
            setDragIndex(null);
            setOverIndex(null);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (dragIndex !== null && dragIndex !== idx) setOverIndex(idx);
          }}
          onDragLeave={() => setOverIndex((prev) => (prev === idx ? null : prev))}
          onDrop={(e) => {
            e.preventDefault();
            handleDrop(idx);
          }}
          style={{
            position: 'relative',
            width: 64,
            height: 64,
            borderRadius: 6,
            border:
              dragIndex === idx
                ? '2px dashed #6b6bff'
                : overIndex === idx
                  ? '2px dashed #3ac7ff'
                  : '1px solid #2a2a3e',
            overflow: 'hidden',
            background: '#1a1a24',
            cursor: 'grab',
            opacity: dragIndex === idx ? 0.55 : 1,
            userSelect: 'none',
          }}
          title="拖动可调整参考图顺序"
        >
          <img
            src={base64Map[filePath] || ''}
            alt={`${altPrefix}-${idx + 1}`}
            style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
          />
          {/* 顺序角标 */}
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: 2,
              width: 16,
              height: 16,
              borderRadius: '50%',
              background: 'rgba(0,0,0,0.65)',
              color: '#cfcfff',
              fontSize: 10,
              lineHeight: '16px',
              textAlign: 'center',
              pointerEvents: 'none',
            }}
          >
            {idx + 1}
          </span>
          <button
            onClick={() => onRemove(filePath)}
            style={{
              position: 'absolute',
              top: 2,
              right: 2,
              width: 18,
              height: 18,
              borderRadius: '50%',
              border: 'none',
              background: 'rgba(0,0,0,0.6)',
              color: '#fff',
              fontSize: 10,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      ))}
      {addSlot}
    </div>
  );
}
