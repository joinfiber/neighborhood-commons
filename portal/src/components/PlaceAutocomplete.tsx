import { useState, useRef, useEffect } from 'react';
import { searchPlaces, type PlaceResult } from '../lib/api';
import { styles, colors } from '../lib/styles';

interface PlaceAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onSelect: (place: PlaceResult) => void;
  placeholder?: string;
  searchCoords?: { latitude: number; longitude: number };
  inputStyle?: React.CSSProperties;
}

export function PlaceAutocomplete({ value, onChange, onSelect, placeholder, searchCoords, inputStyle }: PlaceAutocompleteProps) {
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  function handleChange(val: string) {
    onChange(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (val.length < 3) {
      setResults([]);
      setOpen(false);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const places = await searchPlaces(val, searchCoords);
      setResults(places);
      setOpen(places.length > 0);
      setLoading(false);
    }, 300);
  }

  function handleSelect(place: PlaceResult) {
    onSelect(place);
    onChange(place.name);
    setOpen(false);
    setResults([]);
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <input
        type="text"
        style={inputStyle || styles.input}
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder || 'Search venue...'}
      />
      {loading && (
        <span style={{
          position: 'absolute', right: '12px', top: '10px',
          fontSize: '12px', color: colors.dim,
        }}>
          ...
        </span>
      )}
      {open && results.length > 0 && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          background: colors.card,
          border: `1px solid ${colors.border}`,
          borderRadius: '8px',
          marginTop: '4px',
          zIndex: 10,
          maxHeight: '200px',
          overflowY: 'auto',
        }}>
          {results.map((place) => (
            <button
              key={place.place_id}
              type="button"
              className="dropdown-item"
              style={{
                display: 'block',
                width: '100%',
                padding: '10px 12px',
                background: 'transparent',
                border: 'none',
                borderBottom: `1px solid ${colors.border}`,
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onClick={() => handleSelect(place)}
            >
              <div style={{ fontSize: '13px', color: colors.cream }}>{place.name}</div>
              {place.address && (
                <div style={{ fontSize: '11px', color: colors.dim, marginTop: '2px' }}>
                  {place.address}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
