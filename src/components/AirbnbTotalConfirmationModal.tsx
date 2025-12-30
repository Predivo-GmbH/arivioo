import React, { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, DollarSign, Check } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

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

      // Update search with the confirmed price and resume pipeline
      await supabase
        .from('searches')
        .update({
          airbnb_price: amount,
          airbnb_currency: subtotalCurrency,
          status: 'pending',
          api_error: null,
          api_error_code: null,
        })
        .eq('id', searchId);

      toast({
        title: "Total confirmed",
        description: `${currencySymbol}${amount.toLocaleString()} saved as the Airbnb total`,
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
            Confirm Airbnb Total
          </DialogTitle>
          <DialogDescription>
            We found the subtotal but couldn't verify the final price including taxes & fees.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Subtotal found */}
          {subtotalAmount && (
            <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <p className="text-sm text-amber-700 dark:text-amber-400">
                <span className="font-medium">Subtotal found:</span>{" "}
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
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Skip for now
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={isSaving || !totalAmount}
          >
            {isSaving ? (
              "Saving..."
            ) : (
              <>
                <Check className="w-4 h-4 mr-2" />
                Confirm Total
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
