import React, { useEffect, useState } from 'react';
import { Scene } from '../types';
import { getSceneStatusDisplay } from '../utils/sceneStatus';

interface ImageModalProps {
  scene: Scene;
  selectedStyle?: string;
  sceneInterval?: number;
  sceneIndex?: number;
  sceneCount?: number;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  onRegenerate: (scene: Scene) => Promise<boolean>;
  onGenerateVideoPrompt?: (scene: Scene) => Promise<boolean>;
  onAnimateScene?: (scene: Scene) => Promise<boolean>;
}

export const ImageModal: React.FC<ImageModalProps> = ({
  scene,
  selectedStyle,
  sceneInterval = 6,
  sceneIndex = 0,
  sceneCount = 1,
  onClose,
  onPrevious,
  onNext,
  onRegenerate,
  onGenerateVideoPrompt,
  onAnimateScene
}) => {
  const [activeTab, setActiveTab] = useState<'image' | 'video' | 'prompt'>(
    scene.mediaType === "video" ? "video" : "image"
  );
  const [copied, setCopied] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const canGoPrevious = sceneIndex > 0;
  const canGoNext = sceneIndex < sceneCount - 1;
  const sceneStatusDisplay = getSceneStatusDisplay(scene);
  const sceneStatusClass = {
    idle: "text-gray-400",
    queued: "text-amber-300",
    active: "text-blue-300",
    success: "text-green-400",
    error: "text-red-400",
  }[sceneStatusDisplay.tone];

  useEffect(() => {
    setActiveTab(scene.mediaType === "video" ? "video" : "image");
    setCopied(false);
    setIsProcessing(false);
  }, [scene.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft' && canGoPrevious) onPrevious?.();
      if (event.key === 'ArrowRight' && canGoNext) onNext?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canGoNext, canGoPrevious, onClose, onNext, onPrevious]);

  const handleCopyPrompt = () => {
    if (scene.videoMotionPrompt) {
      navigator.clipboard.writeText(scene.videoMotionPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleGenPromptClick = async () => {
    if (onGenerateVideoPrompt) {
      setIsProcessing(true);
      try {
        await onGenerateVideoPrompt(scene);
      } finally {
        setIsProcessing(false);
      }
    }
  };

  const handleAnimateClick = async () => {
    if (onAnimateScene) {
      setIsProcessing(true);
      try {
        const completed = await onAnimateScene(scene);
        if (completed) setActiveTab('video');
      } finally {
        setIsProcessing(false);
      }
    }
  };

  const handleRegenerateClick = async () => {
    setIsProcessing(true);
    try {
      await onRegenerate(scene);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm p-4">
      <div className="bg-cinema-800 border border-cinema-700 rounded-lg max-w-5xl w-full max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
        
        {/* Header */}
        <div className="flex flex-wrap justify-between items-center p-4 border-b border-cinema-700 bg-cinema-900 gap-3">
          <div>
            <h3 className="text-cinema-gold font-serif text-lg flex items-center">
              Cena {scene.time}
              <span className="ml-3 text-xs font-mono font-normal bg-cinema-800 border border-cinema-700 px-2 py-0.5 rounded text-gray-300">
                {sceneInterval}s
              </span>
            </h3>
            <p className="text-xs text-gray-300 max-w-lg truncate">{scene.action}</p>
            <p className="text-[10px] text-gray-500 mt-1">
              Cena {sceneIndex + 1} de {sceneCount} · {scene.mediaType === "video" ? "V — saída em vídeo" : "I — saída em imagem"}
            </p>
          </div>

          {/* Navigation Tabs */}
          <div className="flex bg-cinema-800 p-1 rounded-lg border border-cinema-700 text-xs">
            {scene.mediaType !== "video" && (
              <button
                onClick={() => setActiveTab('image')}
                className={`px-3 py-1.5 rounded-md font-bold transition flex items-center gap-1.5 ${
                  activeTab === 'image' ? 'bg-cinema-gold text-black shadow' : 'text-gray-400 hover:text-white'
                }`}
              >
                <i className="fas fa-image"></i> Imagem final
              </button>
            )}
            <button
              onClick={() => setActiveTab('video')}
              className={`px-3 py-1.5 rounded-md font-bold transition flex items-center gap-1.5 ${
                activeTab === 'video' ? 'bg-cinema-gold text-black shadow' : 'text-gray-400 hover:text-white'
              }`}
            >
              <i className="fas fa-video"></i> Vídeo Animado
              {scene.videoUrl && <span className="w-2 h-2 rounded-full bg-green-400"></span>}
            </button>
            <button
              onClick={() => setActiveTab('prompt')}
              className={`px-3 py-1.5 rounded-md font-bold transition flex items-center gap-1.5 ${
                activeTab === 'prompt' ? 'bg-cinema-gold text-black shadow' : 'text-gray-400 hover:text-white'
              }`}
            >
              <i className="fas fa-wand-magic-sparkles"></i> Prompt de Animação
            </button>
          </div>

          <button 
            onClick={onClose}
            className="text-gray-400 hover:text-white transition p-2"
          >
            <i className="fas fa-times text-xl"></i>
          </button>
        </div>

        <div className="flex items-center justify-between px-4 py-2 bg-cinema-800 border-b border-cinema-700">
          <button
            onClick={onPrevious}
            disabled={!canGoPrevious || isProcessing}
            className="px-3 py-1.5 rounded text-xs font-bold border border-cinema-600 text-gray-200 hover:border-cinema-gold hover:text-cinema-gold disabled:opacity-35 disabled:cursor-not-allowed"
          >
            <i className="fas fa-chevron-left mr-2"></i>Cena anterior
          </button>
          <span className="text-[10px] text-gray-500 hidden sm:block">Use ← e → para navegar</span>
          <button
            onClick={onNext}
            disabled={!canGoNext || isProcessing}
            className="px-3 py-1.5 rounded text-xs font-bold border border-cinema-600 text-gray-200 hover:border-cinema-gold hover:text-cinema-gold disabled:opacity-35 disabled:cursor-not-allowed"
          >
            Próxima cena<i className="fas fa-chevron-right ml-2"></i>
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 bg-black flex items-center justify-center overflow-y-auto min-h-[360px] p-4 relative">
          {activeTab === 'image' && (
            scene.imageUrl ? (
              <img 
                src={scene.imageUrl} 
                alt={scene.action} 
                className="max-w-full max-h-[60vh] object-contain rounded border border-cinema-700"
              />
            ) : (
              <div className="text-gray-500 flex flex-col items-center">
                <i className="fas fa-image text-4xl mb-2"></i>
                <p>Nenhuma imagem gerada para esta cena.</p>
              </div>
            )
          )}

          {activeTab === 'video' && (
            scene.videoUrl ? (
              <div className="flex flex-col items-center w-full max-w-3xl">
                <video 
                  src={scene.videoUrl} 
                  controls 
                  autoPlay 
                  loop 
                  className="w-full rounded border border-cinema-gold/40 shadow-2xl max-h-[60vh]"
                />
                <div className="mt-2 text-xs text-cinema-gold font-mono flex items-center">
                  <i className="fas fa-check-circle mr-1.5"></i> Clipe de vídeo animado de {sceneInterval}s renderizado com física stop-motion
                </div>
              </div>
            ) : (
              <div className="text-center p-6 max-w-md">
                <div className="w-16 h-16 bg-cinema-gold/10 rounded-full flex items-center justify-center text-cinema-gold mx-auto mb-3 border border-cinema-gold/30">
                  <i className="fas fa-film text-2xl"></i>
                </div>
                <h4 className="text-sm font-bold text-gray-200 mb-1">Vídeo da cena ainda não renderizado</h4>
                <p className="text-xs text-gray-400 mb-4">
                  O quadro-base é usado apenas internamente para criar o clipe final de {sceneInterval}s e não será exportado.
                </p>
                {scene.mediaType === "video" && <button
                  onClick={handleAnimateClick}
                  disabled={isProcessing || scene.videoStatus === 'generating' || !scene.imageUrl}
                  className="bg-cinema-gold hover:bg-yellow-400 text-black px-5 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider transition shadow-lg flex items-center justify-center mx-auto disabled:opacity-50"
                >
                  {isProcessing || scene.videoStatus === 'generating' ? (
                    <>
                      <i className="fas fa-spinner fa-spin mr-2"></i> Animando Vídeo...
                    </>
                  ) : (
                    <>
                      <i className="fas fa-play-circle mr-2"></i> Animar Vídeo Desta Cena ({sceneInterval}s)
                    </>
                  )}
                </button>}
              </div>
            )
          )}

          {activeTab === 'prompt' && (
            <div className="w-full max-w-2xl bg-cinema-900 border border-cinema-700 rounded-lg p-5 flex flex-col space-y-4">
              <div className="flex justify-between items-center border-b border-cinema-700 pb-2">
                <span className="text-xs font-bold text-cinema-gold uppercase tracking-wider flex items-center">
                  <i className="fas fa-robot mr-2"></i> Prompts enviados para esta cena
                </span>
                <span className="text-[10px] text-gray-400">Conteúdo e estilo separados na API</span>
              </div>

              {scene.imagePrompt && (
                <div className="space-y-2">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-green-400">
                    Prompt da imagem — conteúdo enviado como positivePrompt
                  </span>
                  <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-green-900 bg-black p-3 font-mono text-[11px] leading-relaxed text-gray-200">
                    {scene.imagePrompt}
                  </div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-cinema-gold">
                    Estilo visual — enviado separadamente como stylePrompt
                  </span>
                  <div className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded border border-cinema-gold/30 bg-black p-3 font-mono text-[11px] leading-relaxed text-gray-300">
                    {scene.imageStylePrompt || "Sem estilo adicional."}
                  </div>
                </div>
              )}

              <div className="border-t border-cinema-700 pt-3 text-[10px] font-bold uppercase tracking-wider text-blue-300">
                Prompt de animação de vídeo
              </div>

              {scene.videoMotionPrompt ? (
                <div className="space-y-3">
                  <div className="bg-black p-4 rounded border border-cinema-700 text-xs font-mono text-gray-200 whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
                    {scene.videoMotionPrompt}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleCopyPrompt}
                      className="bg-cinema-gold hover:bg-yellow-400 text-black px-4 py-2 rounded text-xs font-bold uppercase transition flex items-center"
                    >
                      <i className={`fas ${copied ? 'fa-check' : 'fa-copy'} mr-2`}></i>
                      {copied ? 'Copiado para a Área de Transferência!' : 'Copiar Prompt de Animação'}
                    </button>
                    {onGenerateVideoPrompt && (
                      <button
                        onClick={handleGenPromptClick}
                        disabled={isProcessing}
                        className="bg-cinema-700 hover:bg-cinema-600 text-gray-200 px-4 py-2 rounded text-xs font-bold transition flex items-center border border-cinema-600"
                      >
                        <i className="fas fa-rotate mr-2"></i> Regerar Prompt com Gemini
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="text-center py-6">
                  <p className="text-xs text-gray-400 mb-4">
                    Gere um prompt de movimento inteligente otimizado por IA para animar esta imagem nas APIs de Vídeo.
                  </p>
                  <button
                    onClick={handleGenPromptClick}
                    disabled={isProcessing}
                    className="bg-cinema-gold text-black px-4 py-2 rounded text-xs font-bold uppercase transition hover:bg-yellow-400"
                  >
                    {isProcessing ? 'Gerando Prompt...' : 'Gerar Prompt de Animação com IA'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer / Actions */}
        <div className="p-4 border-t border-cinema-700 flex flex-wrap justify-between items-center bg-cinema-900 gap-3">
            <div className="text-xs text-gray-400 flex items-center gap-2">
                <span>Status da Cena:</span> 
                <span className={`font-bold ${sceneStatusClass}`}>
                  {sceneStatusDisplay.label}
                </span>
                {scene.videoUrl && (
                  <span className="bg-green-900/60 text-green-300 border border-green-700 text-[10px] px-2 py-0.5 rounded font-bold">
                    Vídeo OK
                  </span>
                )}
            </div>
            
            <div className="flex gap-2">
                <button 
                    onClick={onClose}
                    className="px-4 py-2 rounded text-xs font-bold text-gray-400 hover:text-white border border-transparent hover:border-gray-600 transition"
                >
                    Fechar
                </button>
                <button 
                    onClick={handleRegenerateClick}
                    disabled={isProcessing || scene.status === 'generating'}
                    className="px-4 py-2 bg-cinema-700 hover:bg-cinema-600 text-white rounded text-xs font-bold uppercase tracking-wider transition flex items-center border border-cinema-600 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    <i className={`fas ${isProcessing || scene.status === 'generating' ? 'fa-spinner fa-spin' : 'fa-sync-alt'} mr-2`}></i>
                    {scene.status === 'generating' ? 'Gerando imagem...' : 'Regerar imagem'}
                </button>
                {scene.imageUrl && scene.mediaType === "video" && (
                  <button 
                      onClick={handleAnimateClick}
                      disabled={isProcessing || scene.videoStatus === 'generating'}
                      className="px-4 py-2 bg-cinema-gold hover:bg-yellow-400 text-black rounded text-xs font-bold uppercase tracking-wider shadow-lg transition flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                      <i className={`fas ${isProcessing || scene.videoStatus === 'generating' ? 'fa-spinner fa-spin' : 'fa-play'} mr-2`}></i>
                      {scene.videoStatus === 'generating' ? 'Animando vídeo...' : scene.videoUrl ? 'Regerar vídeo animado' : 'Animar cena em vídeo'}
                  </button>
                )}
            </div>
        </div>
      </div>
    </div>
  );
};
