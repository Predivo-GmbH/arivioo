import { motion } from "framer-motion";

interface AriviooLogoProps {
  size?: "sm" | "md" | "lg";
  showText?: boolean;
  className?: string;
  variant?: "light" | "dark";
}

/**
 * Animated Arivioo Logo - A compass with orbiting savings indicator
 * Represents finding the best deals across platforms
 */
export function AriviooLogo({ 
  size = "md", 
  showText = true, 
  className = "",
  variant = "light"
}: AriviooLogoProps) {
  const sizeClasses = {
    sm: "w-6 h-6",
    md: "w-8 h-8",
    lg: "w-12 h-12"
  };
  
  const textClasses = {
    sm: "text-lg",
    md: "text-xl",
    lg: "text-2xl"
  };
  
  const iconSize = {
    sm: 14,
    md: 18,
    lg: 26
  };

  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <div className={`${sizeClasses[size]} relative flex items-center justify-center`}>
        {/* Gradient background with subtle pulse */}
        <motion.div 
          className="absolute inset-0 bg-gradient-primary rounded-xl shadow-soft"
          animate={{ 
            scale: [1, 1.05, 1],
          }}
          transition={{ 
            duration: 3,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
        
        {/* Main compass/search icon */}
        <svg 
          width={iconSize[size]} 
          height={iconSize[size]} 
          viewBox="0 0 24 24" 
          fill="none" 
          className="text-white relative z-10"
        >
          {/* Compass diamond shape */}
          <motion.path 
            d="M12 2L4 7V17L12 22L20 17V7L12 2Z" 
            stroke="currentColor" 
            strokeWidth="2" 
            strokeLinecap="round" 
            strokeLinejoin="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 2, ease: "easeInOut" }}
          />
          {/* Inner navigation lines */}
          <motion.path 
            d="M12 22V12" 
            stroke="currentColor" 
            strokeWidth="2" 
            strokeLinecap="round" 
            strokeLinejoin="round"
            animate={{ 
              opacity: [0.5, 1, 0.5],
            }}
            transition={{ 
              duration: 2,
              repeat: Infinity,
              ease: "easeInOut"
            }}
          />
          <motion.path 
            d="M12 12L4 7" 
            stroke="currentColor" 
            strokeWidth="2" 
            strokeLinecap="round" 
            strokeLinejoin="round"
            animate={{ 
              opacity: [0.7, 1, 0.7],
            }}
            transition={{ 
              duration: 2,
              repeat: Infinity,
              ease: "easeInOut",
              delay: 0.3
            }}
          />
          <motion.path 
            d="M12 12L20 7" 
            stroke="currentColor" 
            strokeWidth="2" 
            strokeLinecap="round" 
            strokeLinejoin="round"
            animate={{ 
              opacity: [0.6, 1, 0.6],
            }}
            transition={{ 
              duration: 2,
              repeat: Infinity,
              ease: "easeInOut",
              delay: 0.6
            }}
          />
          {/* Center point - pulsing */}
          <motion.circle 
            cx="12" 
            cy="12" 
            r="2" 
            fill="currentColor"
            animate={{ 
              r: [2, 2.5, 2],
              opacity: [0.8, 1, 0.8]
            }}
            transition={{ 
              duration: 1.5,
              repeat: Infinity,
              ease: "easeInOut"
            }}
          />
        </svg>
      </div>
      
      {showText && (
        <span className={`font-bold ${textClasses[size]} ${variant === "dark" ? "text-background" : "text-foreground"} tracking-tight`}>
          Arivioo
        </span>
      )}
    </div>
  );
}

/**
 * Simple static version for places where animation might be distracting
 */
export function AriviooLogoStatic({ 
  size = "md", 
  showText = true, 
  className = "",
  variant = "light"
}: AriviooLogoProps) {
  const sizeClasses = {
    sm: "w-6 h-6",
    md: "w-8 h-8",
    lg: "w-12 h-12"
  };
  
  const textClasses = {
    sm: "text-lg",
    md: "text-xl",
    lg: "text-2xl"
  };
  
  const iconSize = {
    sm: 14,
    md: 18,
    lg: 26
  };

  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <div className={`${sizeClasses[size]} bg-gradient-primary rounded-xl flex items-center justify-center shadow-soft relative overflow-hidden`}>
        {/* Subtle shimmer effect */}
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full animate-[shimmer_3s_infinite]" />
        <svg 
          width={iconSize[size]} 
          height={iconSize[size]} 
          viewBox="0 0 24 24" 
          fill="none" 
          className="text-white relative z-10"
        >
          <path 
            d="M12 2L4 7V17L12 22L20 17V7L12 2Z" 
            stroke="currentColor" 
            strokeWidth="2" 
            strokeLinecap="round" 
            strokeLinejoin="round"
          />
          <path 
            d="M12 22V12" 
            stroke="currentColor" 
            strokeWidth="2" 
            strokeLinecap="round" 
            strokeLinejoin="round"
          />
          <path 
            d="M12 12L4 7" 
            stroke="currentColor" 
            strokeWidth="2" 
            strokeLinecap="round" 
            strokeLinejoin="round"
          />
          <path 
            d="M12 12L20 7" 
            stroke="currentColor" 
            strokeWidth="2" 
            strokeLinecap="round" 
            strokeLinejoin="round"
          />
          <circle cx="12" cy="12" r="2" fill="currentColor"/>
        </svg>
      </div>
      
      {showText && (
        <span className={`font-bold ${textClasses[size]} ${variant === "dark" ? "text-background" : "text-foreground"} tracking-tight`}>
          Arivioo
        </span>
      )}
    </div>
  );
}
