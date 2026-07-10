import React from 'react';
import iconImg from '../assets/images/nurseryos-icon.png';
import fullLogoImg from '../assets/images/nurseryos-logo-full.png';
import legacyLogoImg from '../assets/images/bayou_state_logo.svg';

interface BrandLogoProps {
  variant?: 'icon' | 'full';
  size?: 'sm' | 'md' | 'lg';
  showText?: boolean;
  nurseryName?: string;
  tagline?: string;
  className?: string;
  /** Keep Bayou artwork only when explicitly requested for that nursery. */
  useLegacyArtwork?: boolean;
}

export const BrandLogo: React.FC<BrandLogoProps> = ({
  variant = 'icon',
  size = 'md',
  showText = true,
  nurseryName = 'NurseryOS',
  tagline,
  className = '',
  useLegacyArtwork = false
}) => {
  if (variant === 'full') {
    return (
      <img
        src={fullLogoImg}
        alt="NurseryOS — All-in-one nursery software"
        className={`w-full object-contain select-none ${className}`}
      />
    );
  }

  const containerClasses = {
    sm: 'h-10 w-10',
    md: 'h-14 w-14',
    lg: 'h-28 w-28'
  };

  const imageSrc = useLegacyArtwork ? legacyLogoImg : iconImg;
  const imageAlt = useLegacyArtwork ? nurseryName : 'NurseryOS';

  return (
    <div className={`flex items-center space-x-3 select-none ${className}`}>
      <div
        className={`relative flex items-center justify-center shrink-0 ${containerClasses[size]} bg-white rounded-xl shadow-md border border-emerald-500/20 overflow-hidden p-1`}
      >
        <img src={imageSrc} alt={imageAlt} className="h-full w-full object-contain" />
      </div>

      {showText && (
        <div className="flex flex-col">
          <div className="flex items-baseline">
            <span className="text-lg font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-teal-300 font-sans uppercase">
              {nurseryName}
            </span>
          </div>
          {tagline && (
            <span className="text-[10px] text-emerald-300 tracking-widest font-mono uppercase font-bold leading-none mt-0.5">
              {tagline}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
