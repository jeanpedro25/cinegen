import React from 'react';
import { ANIMATION_STYLES, StylePreset } from '../src/data/styles';

interface StyleSelectorProps {
  selectedStyle: string;
  onSelectStyle: (promptName: string) => void;
}

export const StyleSelector: React.FC<StyleSelectorProps> = ({
  selectedStyle,
  onSelectStyle
}) => {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-xs font-bold text-cinema-gold uppercase tracking-wider flex items-center">
          <i className="fas fa-palette mr-2 text-sm"></i> Estilo de Animação
        </label>
        <span className="text-[10px] text-gray-400 font-mono">
          {ANIMATION_STYLES.length} Estilos Disponíveis
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 max-h-[300px] overflow-y-auto pr-1 custom-scrollbar">
        {ANIMATION_STYLES.map((preset: StylePreset) => {
          const isSelected = selectedStyle === preset.promptName;
          return (
            <div
              key={preset.id}
              onClick={() => onSelectStyle(preset.promptName)}
              className={`relative bg-cinema-900 rounded-lg border cursor-pointer overflow-hidden transition-all flex flex-col group ${
                isSelected
                  ? 'border-cinema-gold ring-1 ring-cinema-gold shadow-lg shadow-cinema-gold/20'
                  : 'border-cinema-700 hover:border-cinema-gold/60 hover:bg-cinema-800'
              }`}
            >
              {/* Preview Thumbnail */}
              <div className="relative aspect-[16/10] bg-black overflow-hidden">
                <img
                  src={preset.previewUrl}
                  onError={(e) => {
                    // Fallback to SVG if external image fails
                    (e.target as HTMLImageElement).src = preset.previewSvg;
                  }}
                  alt={preset.name}
                  className={`w-full h-full object-cover transition-transform duration-300 group-hover:scale-105 ${
                    isSelected ? 'scale-105 opacity-100' : 'opacity-85 group-hover:opacity-100'
                  }`}
                  loading="lazy"
                />
                
                {/* Badge */}
                <div className="absolute top-1.5 left-1.5 bg-black/80 text-cinema-gold text-[9px] font-bold px-1.5 py-0.5 rounded border border-cinema-gold/40 backdrop-blur-sm">
                  {preset.badge}
                </div>

                {/* Selected Checkmark */}
                {isSelected && (
                  <div className="absolute top-1.5 right-1.5 w-5 h-5 bg-cinema-gold text-black rounded-full flex items-center justify-center text-[10px] font-bold shadow">
                    <i className="fas fa-check"></i>
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="p-2 flex flex-col justify-between flex-1 bg-cinema-900/90">
                <h3 className={`text-xs font-bold truncate ${isSelected ? 'text-cinema-gold' : 'text-gray-200'}`}>
                  {preset.name}
                </h3>
                <p className="text-[10px] text-gray-400 line-clamp-2 mt-0.5 leading-tight">
                  {preset.description}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
