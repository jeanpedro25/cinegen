import React from 'react';
import { LogEntry } from '../types';

interface LogViewerProps {
  logs: LogEntry[];
}

export const LogViewer: React.FC<LogViewerProps> = ({ logs }) => {
  return (
    <div className="studio-panel mb-4 overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
        <div>
          <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-gray-200">
            <i className="fas fa-list-check mr-2 text-cinema-gold"></i>
            Linha do tempo / log
          </h3>
          <p className="mt-1 text-[10px] text-gray-500">Acompanhe cada etapa da produção em tempo real</p>
        </div>
        <span className="rounded-lg border border-white/10 bg-black/20 px-2.5 py-1 text-[10px] text-gray-400">
          {logs.length} eventos
        </span>
      </div>
      <div className="studio-scroll h-52 overflow-y-auto p-4 font-mono text-[11px]">
        {logs.length === 0 && <span className="text-gray-600">Sistema pronto. Aguardando dados...</span>}
        {logs.map((log) => (
          <div key={log.id} className="mb-1.5 grid grid-cols-[76px_1fr] gap-2 rounded-lg border border-transparent px-2 py-1.5 hover:border-white/5 hover:bg-white/[0.02]">
            <span className="text-gray-600">[{log.timestamp}]</span>
            <span className={`${
              log.type === 'error' ? 'text-red-400' :
              log.type === 'success' ? 'text-green-400' :
              log.type === 'warning' ? 'text-yellow-400' : 'text-blue-300'
            }`}>
              {log.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
