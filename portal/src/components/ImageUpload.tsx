import { useState, useRef, useCallback } from 'react';
import { colors } from '../lib/styles';

interface ImageUploadProps {
  value: string | null;
  onChange: (base64: string | null) => void;
}

function resizeImage(file: File, maxDim: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('No canvas context'));
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = reject;
      img.src = reader.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function ImageUpload({ value, onChange }: ImageUploadProps) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) return;
    const base64 = await resizeImage(file, 1080);
    onChange(base64);
  }, [onChange]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, [processFile]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  }, [processFile]);

  if (value) {
    return (
      <div style={{ position: 'relative' }}>
        <img
          src={value}
          alt="Event"
          style={{
            width: '100%',
            borderRadius: '8px',
            maxHeight: '200px',
            objectFit: 'cover',
          }}
        />
        <button
          type="button"
          onClick={() => onChange(null)}
          style={{
            position: 'absolute',
            top: '8px',
            right: '8px',
            background: 'rgba(0,0,0,0.7)',
            border: 'none',
            borderRadius: '50%',
            width: '28px',
            height: '28px',
            color: '#fff',
            cursor: 'pointer',
            fontSize: '14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      style={{
        border: `2px dashed ${dragging ? colors.amber : colors.border}`,
        borderRadius: '8px',
        padding: '24px',
        textAlign: 'center',
        cursor: 'pointer',
        transition: 'border-color 0.15s',
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={handleFileInput}
        style={{ display: 'none' }}
      />
      <div style={{ fontSize: '13px', color: colors.muted }}>
        Drop an image or click to upload
      </div>
      <div style={{ fontSize: '11px', color: colors.dim, marginTop: '4px' }}>
        JPEG, PNG, or WebP &middot; Avoid text on your image — it gets cropped and ruins stories.
      </div>
    </div>
  );
}
