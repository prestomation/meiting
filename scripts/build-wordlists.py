#!/usr/bin/env python3
"""
build-wordlists.py — Build authoritative HSK 3.0 wordlists

Sources:
  - ivankra/hsk30: authoritative level assignments (2021 HSK 3.0 standard)
  - drkameleon/complete-hsk-vocabulary: English meanings

Output: scripts/wordlists/hsk{1-6}.json
Schema: [{"characters": "爱", "pinyin": "ài", "english": "to love; to be fond of"}]
"""

import csv
import json
import urllib.request
import re
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
WORDLIST_DIR = os.path.join(SCRIPT_DIR, 'wordlists')

def fetch_url(url):
    print(f"Fetching {url}...")
    with urllib.request.urlopen(url) as r:
        return r.read().decode('utf-8')

def fetch_json(url):
    print(f"Fetching {url}...")
    with urllib.request.urlopen(url) as r:
        return json.load(r)

def parse_ivankra():
    """Download and parse ivankra/hsk30 CSV for authoritative level assignments."""
    url = "https://raw.githubusercontent.com/ivankra/hsk30/master/hsk30.csv"
    content = fetch_url(url)
    
    reader = csv.DictReader(content.splitlines())
    level_map = {}  # level -> list of {characters, pinyin, cedict}
    
    for row in reader:
        # Handle variants like "爸爸|爸" — use first variant
        simplified = row['Simplified'].split('|')[0].strip()
        # Handle pinyin variants
        pinyin = row['Pinyin'].split('|')[0].strip()
        level = row['Level'].strip()
        cedict = row.get('CEDICT', '').strip()
        
        if not simplified or not level:
            continue
        
        if level not in level_map:
            level_map[level] = []
        
        level_map[level].append({
            'characters': simplified,
            'pinyin': pinyin,
            'cedict': cedict,
        })
    
    return level_map

def parse_drkameleon():
    """Download drkameleon/complete-hsk-vocabulary for English meanings."""
    url = "https://raw.githubusercontent.com/drkameleon/complete-hsk-vocabulary/main/complete.json"
    drka_data = fetch_json(url)
    
    # Build lookup: simplified -> english
    english_lookup = {}
    for entry in drka_data:
        simp = entry.get('simplified', '').strip()
        if not simp:
            continue
        forms = entry.get('forms', [])
        if forms:
            meanings = forms[0].get('meanings', [])
            if meanings:
                english_lookup[simp] = '; '.join(meanings[:3])  # up to 3 meanings
    
    return english_lookup

def extract_cedict_english(cedict_str):
    """
    Extract English definitions from a CEDICT entry string.
    CEDICT format: Traditional|Simplified[pinyin] /def1/def2/
    """
    if not cedict_str:
        return ''
    
    # Find definitions between slashes after the pinyin bracket
    match = re.search(r'\[.*?\]\s*(.*)', cedict_str)
    if match:
        defs_str = match.group(1)
        # Split on / and clean up
        defs = [d.strip() for d in defs_str.split('/') if d.strip()]
        if defs:
            return '; '.join(defs[:3])  # take first 3 definitions
    return ''

def build_wordlists():
    os.makedirs(WORDLIST_DIR, exist_ok=True)
    
    print("Step 1: Fetching authoritative HSK 3.0 data from ivankra/hsk30...")
    level_map = parse_ivankra()
    
    print("\nStep 2: Fetching English meanings from drkameleon/complete-hsk-vocabulary...")
    english_lookup = parse_drkameleon()
    
    print(f"\nEnglish lookup has {len(english_lookup)} entries")
    
    print("\nStep 3: Building wordlists per level...")
    
    summary = {}
    for level in ['1', '2', '3', '4', '5', '6']:
        words = level_map.get(level, [])
        result = []
        missing_english = 0
        
        for w in words:
            chars = w['characters']
            pinyin = w['pinyin']
            
            # Try drkameleon first
            english = english_lookup.get(chars, '')
            
            # Fallback: try CEDICT field
            if not english:
                english = extract_cedict_english(w.get('cedict', ''))
                if english:
                    pass  # used CEDICT
                else:
                    missing_english += 1
            
            result.append({
                'characters': chars,
                'pinyin': pinyin,
                'english': english,
            })
        
        outpath = os.path.join(WORDLIST_DIR, f'hsk{level}.json')
        with open(outpath, 'w', encoding='utf-8') as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        
        summary[level] = {
            'count': len(result),
            'missing_english': missing_english,
        }
        print(f"  HSK {level}: {len(result)} words written to {outpath} (missing english: {missing_english})")
    
    print("\nSummary:")
    for level, info in summary.items():
        print(f"  HSK {level}: {info['count']} words, {info['missing_english']} without English")
    
    return summary

if __name__ == '__main__':
    build_wordlists()
