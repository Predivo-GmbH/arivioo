import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

export interface ImageAlignment {
  x: number;
  y: number;
  scale: number;
}

interface AlignmentWithMeta extends ImageAlignment {
  confidence?: number;
  reasoning?: string;
}

const STORAGE_KEY = 'arivioo-image-alignments';

// Generate a unique key for an image pair
const getAlignmentKey = (referenceUrl: string, targetUrl: string): string => {
  // Use a hash of both URLs to create a unique key
  const combined = `${referenceUrl}::${targetUrl}`;
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `align_${Math.abs(hash)}`;
};

// Load all alignments from localStorage
const loadAlignments = (): Record<string, ImageAlignment> => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
};

// Save alignments to localStorage
const saveAlignments = (alignments: Record<string, ImageAlignment>) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(alignments));
  } catch (e) {
    console.warn('Failed to save alignments to localStorage:', e);
  }
};

export function useImageAlignment(referenceUrl: string | null, targetUrl: string | null) {
  const [alignment, setAlignmentState] = useState<ImageAlignment>({ x: 0, y: 0, scale: 1 });
  const [isAutoAligning, setIsAutoAligning] = useState(false);
  const [autoAlignResult, setAutoAlignResult] = useState<AlignmentWithMeta | null>(null);

  const alignmentKey = referenceUrl && targetUrl ? getAlignmentKey(referenceUrl, targetUrl) : null;

  // Load saved alignment on mount or when images change
  useEffect(() => {
    if (!alignmentKey) {
      setAlignmentState({ x: 0, y: 0, scale: 1 });
      setAutoAlignResult(null);
      return;
    }

    const alignments = loadAlignments();
    const saved = alignments[alignmentKey];
    if (saved) {
      setAlignmentState(saved);
    } else {
      setAlignmentState({ x: 0, y: 0, scale: 1 });
    }
    setAutoAlignResult(null);
  }, [alignmentKey]);

  // Update and persist alignment
  const setAlignment = useCallback((newAlignment: ImageAlignment | ((prev: ImageAlignment) => ImageAlignment)) => {
    setAlignmentState(prev => {
      const next = typeof newAlignment === 'function' ? newAlignment(prev) : newAlignment;
      
      // Persist to localStorage
      if (alignmentKey) {
        const alignments = loadAlignments();
        alignments[alignmentKey] = next;
        saveAlignments(alignments);
      }
      
      return next;
    });
  }, [alignmentKey]);

  // Reset alignment
  const resetAlignment = useCallback(() => {
    const defaultAlign = { x: 0, y: 0, scale: 1 };
    setAlignmentState(defaultAlign);
    setAutoAlignResult(null);
    
    if (alignmentKey) {
      const alignments = loadAlignments();
      delete alignments[alignmentKey];
      saveAlignments(alignments);
    }
  }, [alignmentKey]);

  // Auto-align using AI
  const autoAlign = useCallback(async () => {
    if (!referenceUrl || !targetUrl) {
      toast.error('Both images are required for auto-alignment');
      return;
    }

    setIsAutoAligning(true);
    
    try {
      const { data, error } = await supabase.functions.invoke('analyze-image-alignment', {
        body: {
          referenceImageUrl: referenceUrl,
          targetImageUrl: targetUrl,
        },
      });

      if (error) {
        throw new Error(error.message || 'Failed to analyze images');
      }

      const result = data.alignment as AlignmentWithMeta;
      
      setAutoAlignResult(result);
      setAlignment({ x: result.x, y: result.y, scale: result.scale });
      
      if (result.confidence && result.confidence >= 0.7) {
        toast.success('Images auto-aligned successfully');
      } else if (result.confidence && result.confidence >= 0.4) {
        toast.info('Auto-alignment applied with moderate confidence');
      } else {
        toast.warning('Low confidence alignment - images may show different angles');
      }
    } catch (error) {
      console.error('Auto-align error:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to auto-align images');
    } finally {
      setIsAutoAligning(false);
    }
  }, [referenceUrl, targetUrl, setAlignment]);

  return {
    alignment,
    setAlignment,
    resetAlignment,
    autoAlign,
    isAutoAligning,
    autoAlignResult,
  };
}
