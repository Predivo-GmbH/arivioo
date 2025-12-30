import { useState } from 'react';
import { DollarSign, Upload, Check, Edit2, X, AlertTriangle, Info } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';

interface AirbnbTotalConfirmationProps {
  searchId: string;
  subtotalAmount?: number | null;
  subtotalNights?: number | null;
  subtotalCurrency?: string;
  existingConfirmation?: {
    confirmed_total_amount: number;
    confirmed_currency: string;
    confirmation_source: string;
    confirmed_at: string;
  } | null;
  onConfirmed?: (amount: number, currency: string) => void;
  onCleared?: () => void;
}

const CURRENCIES = [
  { code: 'USD', symbol: '$', label: 'USD ($)' },
  { code: 'EUR', symbol: '€', label: 'EUR (€)' },
  { code: 'GBP', symbol: '£', label: 'GBP (£)' },
  { code: 'CHF', symbol: 'CHF', label: 'CHF' },
  { code: 'AUD', symbol: 'A$', label: 'AUD (A$)' },
  { code: 'CAD', symbol: 'C$', label: 'CAD (C$)' },
];

export function AirbnbTotalConfirmation({
  searchId,
  subtotalAmount,
  subtotalNights,
  subtotalCurrency = 'USD',
  existingConfirmation,
  onConfirmed,
  onCleared,
}: AirbnbTotalConfirmationProps) {
  const [isEditing, setIsEditing] = useState(!existingConfirmation);
  const [totalAmount, setTotalAmount] = useState(existingConfirmation?.confirmed_total_amount?.toString() || '');
  const [currency, setCurrency] = useState(existingConfirmation?.confirmed_currency || subtotalCurrency);
  const [confirmationText, setConfirmationText] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const getCurrencySymbol = (code: string) => {
    return CURRENCIES.find(c => c.code === code)?.symbol || '$';
  };

  const handleSave = async () => {
    const amount = parseFloat(totalAmount);
    if (isNaN(amount) || amount <= 0) {
      toast({ title: 'Invalid amount', description: 'Please enter a valid trip total', variant: 'destructive' });
      return;
    }

    setIsSaving(true);
    try {
      // Upsert the confirmation
      const { error } = await supabase
        .from('airbnb_confirmed_totals')
        .upsert({
          search_id: searchId,
          confirmed_total_amount: amount,
          confirmed_currency: currency,
          subtotal_nights_only: subtotalAmount,
          subtotal_nights_count: subtotalNights,
          confirmation_source: 'user',
          confirmation_text: confirmationText || null,
          confirmed_at: new Date().toISOString(),
        }, {
          onConflict: 'search_id',
        });

      if (error) throw error;

      toast({ title: 'Total confirmed', description: `Trip total of ${getCurrencySymbol(currency)}${amount.toLocaleString()} saved` });
      setIsEditing(false);
      onConfirmed?.(amount, currency);
    } catch (err: any) {
      toast({ title: 'Error saving', description: err.message, variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleClear = async () => {
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('airbnb_confirmed_totals')
        .delete()
        .eq('search_id', searchId);

      if (error) throw error;

      toast({ title: 'Confirmation cleared', description: 'You can enter a new total' });
      setTotalAmount('');
      setConfirmationText('');
      setIsEditing(true);
      onCleared?.();
    } catch (err: any) {
      toast({ title: 'Error clearing', description: err.message, variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  };

  // If we have a confirmed total and not editing, show the confirmed state
  if (existingConfirmation && !isEditing) {
    return (
      <Card className="border-green-500/50 bg-green-500/5">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Check className="h-5 w-5 text-green-600" />
              <CardTitle className="text-lg text-green-700">Trip Total Confirmed</CardTitle>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
                <Edit2 className="h-4 w-4 mr-1" />
                Edit
              </Button>
              <Button variant="ghost" size="sm" onClick={handleClear} disabled={isSaving}>
                <X className="h-4 w-4 mr-1" />
                Clear
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-green-700">
              {getCurrencySymbol(existingConfirmation.confirmed_currency)}
              {existingConfirmation.confirmed_total_amount.toLocaleString()}
            </span>
            <Badge variant="outline" className="text-green-600 border-green-400">
              Incl. taxes & fees
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-2">
            Confirmed {new Date(existingConfirmation.confirmed_at).toLocaleDateString()}
          </p>
        </CardContent>
      </Card>
    );
  }

  // Show the confirmation form
  return (
    <Card className="border-amber-500/50 bg-amber-500/5">
      <CardHeader>
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-amber-600" />
          <CardTitle className="text-lg text-amber-700">Confirm Trip Total</CardTitle>
        </div>
        <CardDescription>
          We could not verify the trip total automatically. Please enter the total shown on Airbnb for your selected dates.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {subtotalAmount && subtotalNights && (
          <div className="p-3 bg-muted rounded-lg">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Info className="h-4 w-4" />
              <span>Context: Subtotal (nights only)</span>
            </div>
            <p className="font-medium mt-1">
              {getCurrencySymbol(subtotalCurrency)}{subtotalAmount.toLocaleString()} for {subtotalNights} nights
            </p>
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2 space-y-2">
            <Label htmlFor="tripTotal">Trip Total (incl. taxes & fees)</Label>
            <div className="relative">
              <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="tripTotal"
                type="number"
                step="0.01"
                min="0"
                placeholder="Enter total amount"
                value={totalAmount}
                onChange={(e) => setTotalAmount(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Currency</Label>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CURRENCIES.map(c => (
                  <SelectItem key={c.code} value={c.code}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="proofText">Proof (optional)</Label>
          <Textarea
            id="proofText"
            placeholder='Paste the "Total ..." line from Airbnb'
            value={confirmationText}
            onChange={(e) => setConfirmationText(e.target.value)}
            rows={2}
          />
        </div>

        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={isSaving || !totalAmount} className="flex-1">
            {isSaving ? 'Saving...' : 'Save Total'}
          </Button>
          {existingConfirmation && (
            <Button variant="outline" onClick={() => setIsEditing(false)}>
              Cancel
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
