
import React from 'react';
import { INTERVAL_OPTIONS } from '../types';
import { StyleSelector } from './StyleSelector';

interface SettingsPanelProps {
  selectedStyle: string;
  setSelectedStyle: (val: string) => void;
  sceneInterval: number;
  setSceneInterval: (val: number) => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  selectedStyle,
  setSelectedStyle,
  sceneInterval,
  setSceneInterval
}) => {
  return (
    <div className="bg-cinema-800 border-r border-cinema-700 w-full md:w-80 flex-shrink-0 flex flex-col h-full overflow-y-auto">
      <div className="p-4 border-b border-cinema-700 flex justify-between items-center">
        <div>
          <h1 className="font-serif text-xl text-cinema-gold font-bold flex items-center">
            <i className="fas fa-film mr-2 text-cinema-gold"></i>CineGen IA
          </h1>
          <p className="text-[10px] text-gray-400 uppercase tracking-widest font-mono">Estúdio de Animação</p>
        </div>
        <span className="bg-cinema-gold/20 text-cinema-gold text-[9px] px-2 py-0.5 rounded font-bold border border-cinema-gold/40">
          v2.5
        </span>
      </div>

      <div className="p-4 space-y-4">
        {/* Sogni API Status Banner */}
        <div className="bg-cinema-900 p-2.5 rounded border border-green-500/40 shadow-sm space-y-1">
            <div className="flex items-center justify-between text-xs font-bold text-green-400">
              <span className="flex items-center text-[11px]"><i className="fas fa-bolt mr-1 text-cinema-gold"></i> Sogni.ai API Conectada</span>
              <span className="bg-green-900/60 text-green-300 text-[8px] px-1.5 py-0.2 rounded font-mono border border-green-700/50">UNLIMITED • 4x</span>
            </div>
            <div className="text-[10px] text-gray-300 font-mono flex items-center justify-between">
              <span>Modelo: <strong className="text-cinema-gold">Krea 2 Turbo</strong></span>
              <span className="text-gray-400">SDK Oficial</span>
            </div>
        </div>

        {/* Style Selector Visual Cards */}
        <StyleSelector 
          selectedStyle={selectedStyle} 
          onSelectStyle={setSelectedStyle} 
        />

        {/* Scene Interval Selector */}
        <div className="space-y-1.5 pt-1 border-t border-cinema-700">
          <label className="text-xs font-bold text-gray-300 uppercase tracking-wider block flex justify-between items-center">
            <span>Intervalo dos Cortes</span>
            <span className="text-[10px] text-cinema-gold font-mono">CapCut: 6s</span>
          </label>
          <div className="grid grid-cols-5 gap-1">
             {INTERVAL_OPTIONS.map((opt) => (
               <button
                 key={opt.value}
                 onClick={() => setSceneInterval(opt.value)}
                 title={opt.description}
                 className={`text-xs py-1.5 rounded border transition-all flex flex-col items-center justify-center font-mono ${
                   sceneInterval === opt.value 
                     ? 'bg-cinema-gold text-black border-cinema-gold font-bold shadow' 
                     : 'bg-cinema-900 text-gray-400 border-cinema-700 hover:bg-cinema-700 hover:text-white'
                 }`}
               >
                 <span>{opt.label}</span>
               </button>
             ))}
          </div>
          <p className="text-[9px] text-cinema-gold font-mono mt-0.5">
            ✨ Cenas de {sceneInterval}s prontas para CapCut, TikTok & Reels
          </p>
        </div>

        {/* CapCut Integration Banner */}
        <div className="bg-gradient-to-r from-cinema-900 to-cinema-800 p-2.5 rounded border border-cinema-700">
            <div className="flex items-center text-cinema-gold text-[11px] font-bold mb-0.5">
              <i className="fas fa-cut mr-1.5"></i> Exportação Timeline CapCut
            </div>
            <span className="text-[10px] text-gray-400 block leading-tight">
              Exporta clipes de vídeo, legendas SRT e arquivos numerados prontos para edição.
            </span>
        </div>
      </div>
      
      <div className="mt-auto p-3 text-center text-gray-500 text-[10px] font-mono border-t border-cinema-700/50">
        CineGen IA • Sogni.ai Krea 2 Turbo
      </div>
    </div>
  );
};
