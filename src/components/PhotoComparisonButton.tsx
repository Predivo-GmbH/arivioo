import { Camera, Eye, ArrowLeftRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PhotoComparisonButtonProps {
  isExpanded: boolean;
  onToggle: () => void;
  hasImages: boolean;
}

export function PhotoComparisonButton({ isExpanded, onToggle, hasImages }: PhotoComparisonButtonProps) {
  if (!hasImages) return null;
  
  return (
    <Button
      variant={isExpanded ? "secondary" : "outline"}
      size="sm"
      onClick={onToggle}
      className="flex items-center gap-2 text-xs font-medium"
    >
      <ArrowLeftRight className="w-3.5 h-3.5" />
      {isExpanded ? "Hide Photos" : "Compare Photos"}
    </Button>
  );
}
