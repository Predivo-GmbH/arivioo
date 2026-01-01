import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// Secure CORS - Domain allowlist
const ALLOWED_ORIGINS = [
  'https://lovable.dev',
  'https://www.lovable.dev',
  /^https:\/\/[a-zA-Z0-9-]+\.lovable\.app$/,
  /^https:\/\/[a-zA-Z0-9-]+\.lovableproject\.com$/,
  /^https:\/\/id-preview--[a-zA-Z0-9-]+\.lovable\.app$/,
  'https://arivioo.lovable.app',
  'https://arivioo.com',
  'https://www.arivioo.com',
];

function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.some(allowed => {
    if (typeof allowed === 'string') return origin === allowed;
    return allowed.test(origin);
  });
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Allowed image URL domains for SSRF protection
const ALLOWED_DOMAINS = [
  'airbnb.com',
  'airbnbusercontent.com',
  'a0.muscache.com',
  'booking.com',
  'bstatic.com',
  'vrbo.com',
  'expedia.com',
  'hotels.com',
  'tripadvisor.com',
  'agoda.com',
  'trip.com',
  'hostelworld.com',
  'trivago.com',
  // Google image CDN domains (used for cached/thumbnail images in search results)
  'gstatic.com',
  'googleusercontent.com',
  'ggpht.com',
];

function isAllowedUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();
    return ALLOWED_DOMAINS.some(domain => 
      hostname === domain || hostname.endsWith('.' + domain)
    );
  } catch {
    return false;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // JWT is now verified by Supabase Edge Functions runtime (verify_jwt = true)
    // Extract user info from auth header for logging
    const authHeader = req.headers.get('authorization');
    const userId = authHeader ? 'authenticated' : 'unknown';
    
    const { referenceImageUrl, targetImageUrl } = await req.json();
    
    console.log(`[analyze-image-alignment] Request from user: ${userId}`);
    
    if (!referenceImageUrl || !targetImageUrl) {
      return new Response(
        JSON.stringify({ error: 'Both referenceImageUrl and targetImageUrl are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate URLs are from allowed domains (SSRF protection)
    if (!isAllowedUrl(referenceImageUrl)) {
      console.warn(`[analyze-image-alignment] Blocked disallowed reference URL: ${referenceImageUrl}`);
      return new Response(
        JSON.stringify({ error: 'Reference image URL must be from a supported booking platform' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    if (!isAllowedUrl(targetImageUrl)) {
      console.warn(`[analyze-image-alignment] Blocked disallowed target URL: ${targetImageUrl}`);
      return new Response(
        JSON.stringify({ error: 'Target image URL must be from a supported booking platform' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      throw new Error('LOVABLE_API_KEY is not configured');
    }

    const systemPrompt = `You are an image alignment analyzer. Given two images of the same property from different platforms, analyze them and determine how to crop/pan the second image to best align with the first.

Return a JSON object with these fields:
- x: horizontal pan offset from -100 (far left) to 100 (far right). 0 is center.
- y: vertical pan offset from -100 (top) to 100 (bottom). 0 is center.
- scale: zoom level from 1.0 (no zoom) to 2.0 (2x zoom). Use zoom if the target image shows more area.
- confidence: your confidence in this alignment from 0 to 1.
- reasoning: brief explanation of alignment strategy.

Focus on matching key visual elements like furniture, windows, architectural features, or room corners. If images show different angles or areas, return x:0, y:0, scale:1 with low confidence.`;

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { 
            role: 'user', 
            content: [
              { type: 'text', text: 'Analyze these two property images. The first is the reference (Airbnb), the second is from another platform. Determine optimal x, y, scale values to align the second image with the first. Return ONLY valid JSON.' },
              { type: 'image_url', image_url: { url: referenceImageUrl } },
              { type: 'image_url', image_url: { url: targetImageUrl } }
            ]
          }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'return_alignment',
              description: 'Return the optimal alignment parameters for the target image',
              parameters: {
                type: 'object',
                properties: {
                  x: { type: 'number', description: 'Horizontal pan from -100 to 100' },
                  y: { type: 'number', description: 'Vertical pan from -100 to 100' },
                  scale: { type: 'number', description: 'Zoom scale from 1.0 to 2.0' },
                  confidence: { type: 'number', description: 'Confidence score 0-1' },
                  reasoning: { type: 'string', description: 'Brief explanation' }
                },
                required: ['x', 'y', 'scale', 'confidence', 'reasoning'],
                additionalProperties: false
              }
            }
          }
        ],
        tool_choice: { type: 'function', function: { name: 'return_alignment' } }
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: 'Rate limit exceeded. Please try again later.' }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: 'AI credits exhausted. Please add funds.' }),
          { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      const errorText = await response.text();
      console.error('AI gateway error:', response.status, errorText);
      throw new Error(`AI gateway error: ${response.status}`);
    }

    const data = await response.json();
    
    // Extract alignment from tool call
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall?.function?.arguments) {
      const alignment = JSON.parse(toolCall.function.arguments);
      
      // Clamp values to valid ranges
      alignment.x = Math.max(-100, Math.min(100, alignment.x || 0));
      alignment.y = Math.max(-100, Math.min(100, alignment.y || 0));
      alignment.scale = Math.max(1, Math.min(2, alignment.scale || 1));
      alignment.confidence = Math.max(0, Math.min(1, alignment.confidence || 0));
      
      return new Response(
        JSON.stringify({ alignment }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fallback: try to parse from message content
    const content = data.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return new Response(
        JSON.stringify({ 
          alignment: {
            x: Math.max(-100, Math.min(100, parsed.x || 0)),
            y: Math.max(-100, Math.min(100, parsed.y || 0)),
            scale: Math.max(1, Math.min(2, parsed.scale || 1)),
            confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
            reasoning: parsed.reasoning || 'Auto-aligned based on visual analysis'
          }
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Default alignment if AI couldn't determine
    return new Response(
      JSON.stringify({ 
        alignment: { x: 0, y: 0, scale: 1, confidence: 0, reasoning: 'Could not determine alignment' }
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in analyze-image-alignment:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
