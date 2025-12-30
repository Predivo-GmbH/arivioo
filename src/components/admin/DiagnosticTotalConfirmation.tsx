import { useState } from 'react';
import { DollarSign, Check, Edit2, X, AlertTriangle, Beaker } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { useAdminAuth } from '@/hooks/useAdminAuth';

interface DiagnosticTotalConfirmationProps {
  runId: string;
  subtotalAmount?: number | null;
  subtotalNights?: number | null;
  subtotalCurrency?: string;
  existingConfirmation?: {
    confirmed_total_amount: number;
    confirmed_currency: string;
    confirmation_source: string;
    confirmed_at: string;
    confirmation_note?: string;
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

export function DiagnosticTotalConfirmation({
  runId,
  subtotalAmount,
  subtotalNights,
  subtotalCurrency = 'USD',
  existingConfirmation,
  onConfirmed,
  onCleared,
}: DiagnosticTotalConfirmationProps) {
  const { getToken } = useAdminAuth();
  const [isEditing, setIsEditing] = useState(!existingConfirmation);
  const [totalAmount, setTotalAmount] = useState(existingConfirmation?.confirmed_total_amount?.toString() || '');
  const [currency, setCurrency] = useState(existingConfirmation?.confirmed_currency || subtotalCurrency);
  const [confirmationNote, setConfirmationNote] = useState(existingConfirmation?.confirmation_note || '');
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
      // Use admin endpoint to save diagnostic confirmation
      const token = getToken();
      const { error } = await supabase.functions.invoke('admin-dashboard/confirm-diagnostic-total', {
        headers: { Authorization: `Bearer ${token}` },
        body: {
          run_id: runId,
          confirmed_total_amount: amount,
          confirmed_currency: currency,
          subtotal_nights_only: subtotalAmount,
          subtotal_nights_count: subtotalNights,
          confirmation_note: confirmationNote || null,
        },
      });

      if (error) throw error;

      toast({ title: 'Diagnostic total confirmed', description: `Trip total of ${getCurrencySymbol(currency)}${amount.toLocaleString()} saved (testing only)` });
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
      const token = getToken();
      const { error } = await supabase.functions.invoke('admin-dashboard/clear-diagnostic-total', {
        headers: { Authorization: `Bearer ${token}` },
        body: { run_id: runId },
      });

      if (error) throw error;

      toast({ title: 'Confirmation cleared' });
      setTotalAmount('');
      setConfirmationNote('');
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
      <Card className="border-blue-500/50 bg-blue-500/5">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Beaker className="h-5 w-5 text-blue-600" />
              <CardTitle className="text-base text-blue-700">Manual Confirmation (Testing Only)</CardTitle>
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
            <span className="text-2xl font-bold text-blue-700">
              {getCurrencySymbol(existingConfirmation.confirmed_currency)}
              {existingConfirmation.confirmed_total_amount.toLocaleString()}
            </span>
            <Badge variant="outline" className="text-blue-600 border-blue-400">
              diagnostic_test
            </Badge>
          </div>
          {existingConfirmation.confirmation_note && (
            <p className="text-sm text-muted-foreground mt-2">
              Note: {existingConfirmation.confirmation_note}
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  // Show the confirmation form
  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <CardTitle className="text-base text-amber-700">Needs User Confirmation</CardTitle>
        </div>
        <CardDescription className="text-sm">
          No proven trip total available. Enter manual confirmation for testing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {subtotalAmount && subtotalNights && (
          <div className="p-2 bg-muted rounded text-sm">
            <span className="text-muted-foreground">Subtotal (nights only): </span>
            <span className="font-medium">
              {getCurrencySymbol(subtotalCurrency)}{subtotalAmount.toLocaleString()} for {subtotalNights} nights
            </span>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2 space-y-1">
            <Label htmlFor="diagTotal" className="text-xs">Trip Total</Label>
            <div className="relative">
              <DollarSign className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                id="diagTotal"
                type="number"
                step="0.01"
                min="0"
                placeholder="Enter total"
                value={totalAmount}
                onChange={(e) => setTotalAmount(e.target.value)}
                className="pl-7 h-9"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Currency</Label>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger className="h-9">
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

        <div className="space-y-1">
          <Label htmlFor="diagNote" className="text-xs">Note (optional)</Label>
          <Textarea
            id="diagNote"
            placeholder="Testing notes..."
            value={confirmationNote}
            onChange={(e) => setConfirmationNote(e.target.value)}
            rows={1}
            className="min-h-[36px]"
          />
        </div>

        <div className="flex gap-2">
          <Button size="sm" onClick={handleSave} disabled={isSaving || !totalAmount} className="flex-1">
            <Beaker className="h-4 w-4 mr-1" />
            {isSaving ? 'Saving...' : 'Confirm (Testing)'}
          </Button>
          {existingConfirmation && (
            <Button variant="outline" size="sm" onClick={() => setIsEditing(false)}>
              Cancel
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
