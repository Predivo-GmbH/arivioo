import React, { useState, useEffect } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, DollarSign, Check, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface AirbnbTotalConfirmationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  searchId: string;
  subtotalAmount: number | null;
  subtotalNights: number | null;
  subtotalCurrency: string;
  onConfirmed: (confirmedTotal: number, currency: string) => void;
}

const getCurrencySymbol = (currency: string): string => {
  switch (currency) {
    case 'EUR': return '€';
    case 'GBP': return '£';
    case 'CHF': return 'CHF ';
    default: return '$';
  }
};

export function AirbnbTotalConfirmationModal({
  open,
  onOpenChange,
  searchId,
  subtotalAmount,
  subtotalNights,
  subtotalCurrency,
  onConfirmed,
}: AirbnbTotalConfirmationModalProps) {
  const { toast } = useToast();
  const [totalAmount, setTotalAmount] = useState<string>("");
  const [isSaving, setIsSaving] = useState(false);

  const currencySymbol = getCurrencySymbol(subtotalCurrency);

  // Pre-fill with subtotal if available
  useEffect(() => {
    if (subtotalAmount && !totalAmount) {
      setTotalAmount(subtotalAmount.toString());
    }
  }, [subtotalAmount]);

  const handleConfirm = async () => {
    const amount = parseFloat(totalAmount);
    if (!amount || amount < 10) {
      toast({
        title: "Invalid amount",
        description: "Please enter the total price shown on Airbnb (including taxes & fees)",
        variant: "destructive",
      });
      return;
    }

    setIsSaving(true);

    try {
      // Save to airbnb_confirmed_totals
      const { error } = await supabase
        .from('airbnb_confirmed_totals')
        .upsert({
          search_id: searchId,
          confirmed_total_amount: amount,
          confirmed_currency: subtotalCurrency,
          confirmation_source: 'user',
          subtotal_nights_only: subtotalAmount,
          subtotal_nights_count: subtotalNights,
          confirmed_at: new Date().toISOString(),
        }, {
          onConflict: 'search_id',
        });

      if (error) throw error;

      // Update search with the confirmed price (status stays as-is - pipeline continues in background)
      await supabase
        .from('searches')
        .update({
          airbnb_price: amount,
          airbnb_currency: subtotalCurrency,
        })
        .eq('id', searchId);

      toast({
        title: "Total confirmed",
        description: `${currencySymbol}${amount.toLocaleString()} saved. Search continues...`,
      });

      onConfirmed(amount, subtotalCurrency);
      onOpenChange(false);
    } catch (err) {
      console.error('Failed to save confirmed total:', err);
      toast({
        title: "Error",
        description: "Failed to save the confirmed total. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {/* Transparent overlay - no dim, search visible behind */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-50" />
        <DialogPrimitive.Content
          className={cn(
            "fixed z-50 grid w-full max-w-md gap-4 border bg-background p-6 shadow-2xl duration-200",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "sm:rounded-lg",
            // Position at bottom-right corner so search progress is visible
            "bottom-4 right-4 left-auto top-auto translate-x-0 translate-y-0"
          )}
        >
          <div className="flex flex-col space-y-1.5">
            <DialogPrimitive.Title className="flex items-center gap-2 text-lg font-semibold leading-none tracking-tight">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              Confirm Airbnb Total
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="text-sm text-muted-foreground">
              Please enter the final total including taxes & fees while we search.
            </DialogPrimitive.Description>
          </div>

          <div className="space-y-4">
            {/* Subtotal found */}
            {subtotalAmount && (
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  <span className="font-medium">Found:</span>{" "}
                  {currencySymbol}{subtotalAmount.toLocaleString()}
                  {subtotalNights && ` for ${subtotalNights} nights`}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  This may not include taxes, cleaning fees, or service fees.
                </p>
              </div>
            )}

            {/* Input for correct total */}
            <div className="space-y-2">
              <Label htmlFor="total-amount" className="text-sm font-medium">
                Enter the total from Airbnb (including all fees)
              </Label>
              <div className="relative">
                <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  id="total-amount"
                  type="number"
                  placeholder="e.g. 2213.34"
                  value={totalAmount}
                  onChange={(e) => setTotalAmount(e.target.value)}
                  className="pl-9"
                  min="10"
                  step="0.01"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Look for "Total" or "Trip total" at the bottom of the Airbnb booking panel.
              </p>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              Skip for now
            </Button>
            <Button
              size="sm"
              onClick={handleConfirm}
              disabled={isSaving || !totalAmount}
            >
              {isSaving ? (
                "Saving..."
              ) : (
                <>
                  <Check className="w-4 h-4 mr-2" />
                  Confirm
                </>
              )}
            </Button>
          </div>

          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
